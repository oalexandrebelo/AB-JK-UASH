import { isAbsolute, dirname, basename } from 'node:path';
import { readPrivateFile } from '../jk/vendor/integrations/secrets.mjs';
import { createBaileysAdapter } from './adapter.mjs';

async function main() {
  const command=process.argv[2];
  if(!['status','pair'].includes(command) || process.argv.length!==3)throw new Error('USE_STATUS_OR_PAIR');
  if(command==='pair' && (!process.stdin.isTTY || !process.stdout.isTTY))throw new Error('BAILEYS_PAIR_REQUIRES_PRIVATE_TERMINAL');
  const file=process.env.AB_JK_BAILEYS_CONFIG_FILE;
  if(!file || !isAbsolute(file))throw new Error('BAILEYS_CONFIG_FILE_REQUIRED');
  const bytes=await readPrivateFile(dirname(file),basename(file),64*1024);
  const config=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  let adapter,requested=false;
  try {
    adapter=await createBaileysAdapter(config,{onPairing:async()=>{
      if(requested)return;
      requested=true;
      const code=await adapter.requestPairingCode();
      process.stdout.write(`\nCódigo privado de pareamento: ${code}\nNo WhatsApp do titular: Aparelhos conectados → Conectar aparelho → Conectar com número de telefone.\n`);
    }});
    if(command==='status') { process.stdout.write(`${JSON.stringify(adapter.status())}\n`);return; }
    process.stdout.write('A conexão será iniciada para parear o aparelho. Esta ferramenta não envia mensagens.\n');
    await adapter.connect();
    await new Promise(resolve=>{
      let previous;
      const timer=setInterval(()=>{
        const state=adapter.status().connection;
        if(state!==previous){process.stdout.write(`Conexão: ${state}\n`);previous=state;}
        if(state==='connected' || ['reauth-required','account-mismatch','reconnect-exhausted','connection-error','storage-error'].includes(state))finish();
      },250);
      const interrupt=()=>finish();
      const deadline=setTimeout(()=>finish(),180_000);
      const finish=()=>{clearInterval(timer);clearTimeout(deadline);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);resolve();};
      process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
    });
    if(adapter.status().connection!=='connected')throw new Error('BAILEYS_PAIRING_UNCONFIRMED');
    process.stdout.write('Aparelho conectado e credenciais persistidas. O processo será fechado; inicie o servidor com o mesmo authDir.\n');
  } finally {await adapter?.close();}
}

main().catch(error=>{
  const code=typeof error.message==='string' && /^[A-Z][A-Z0-9_]{1,100}$/u.test(error.message) ? error.message : 'BAILEYS_OPERATION_FAILED';
  process.stderr.write(`${code}\n`);process.exitCode=1;
});
