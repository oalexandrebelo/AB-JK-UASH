#!/usr/bin/env node
/** Optional authoring CLI. Nothing here is imported by src/, server/, or the app build. */
import {readFile, writeFile, mkdir, mkdtemp, cp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url));
const modules=resolve(process.env.JK_MEDIA_NODE_MODULES || join(here,'node_modules'));
const python=process.env.JK_MEDIA_PYTHON || 'python3.13';
const earshot=process.env.JK_MEDIA_EARSHOT_SOURCE;
if(!earshot) throw new Error('Set JK_MEDIA_EARSHOT_SOURCE to the checksum-verified source from fetch-upstream.py.');
for(const [name,version] of [['hyperframes','0.8.214'],['gsap','3.15.0']]) {
  const p=JSON.parse(await readFile(join(modules,name,'package.json'),'utf8'));
  if(p.version!==version) throw new Error(`Expected ${name}@${version}; found ${p.version}.`);
}
const pins=JSON.parse(await readFile(join(here,'upstream.lock.json'),'utf8'));
for(const [file,digest] of Object.entries(pins.earshot.sourceFiles)) {
  if(createHash('sha256').update(await readFile(join(earshot,file))).digest('hex')!==digest) throw new Error(`Earshot source mismatch: ${file}`);
}
const output=join(here,'outputs'), evidence=join(here,'evidence');
await mkdir(output,{recursive:true}); await mkdir(evidence,{recursive:true});
const stage=await mkdtemp(join(tmpdir(),'ab-jk-film-'));
const commands=[];
const env={...process.env,EARSHOT_OFFLINE:'1',HYPERFRAMES_NO_TELEMETRY:'1',DO_NOT_TRACK:'1'};
function run(executable,args,label) {
  console.log(label);
  const result=spawnSync(executable,args,{cwd:here,env,encoding:'utf8',maxBuffer:16*1024*1024});
  const out=(result.stdout||'')+(result.stderr||'');
  commands.push({step:label,exitCode:result.status,output:out.replaceAll(stage,'<temporary-stage>').replaceAll(here,'design/media')});
  process.stdout.write(out);
  if(result.status!==0) throw new Error(`${label} failed (${result.status}): ${result.error?.message||''}`);
}
let passed=false;
try {
  run(python,[join(here,'sources/render_audio.py'),'--earshot-source',earshot,'--output',output],'Earshot procedural render and check');
  run(python,['-m','manimgx','render',join(here,'sources/order_scene.py'),'-o',join(output,'order-flow.mp4'),'-r','1280x720','--fps','24','--preset','fast'],'ManimGX render and layout inspection');
  run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',join(output,'order-flow.mp4'),'-vf','fps=24,tpad=stop_mode=clone:stop_duration=1','-t','8','-an','-c:v','libx264','-preset','fast','-crf','20','-g','24','-keyint_min','24','-pix_fmt','yuv420p','-movflags','+faststart',join(output,'order-flow-cfr.mp4')],'FFmpeg normalize ManimGX VFR to CFR for Hyperframes');
  await mkdir(join(stage,'assets'));
  for(const file of ['order-flow-cfr.mp4','jk-ready.wav']) await cp(join(output,file),join(stage,'assets',file));
  await cp(join(modules,'gsap/dist/gsap.min.js'),join(stage,'assets/gsap.min.js'));
  await cp(join(here,'sources/composition.html'),join(stage,'index.html'));
  const cli=join(modules,'hyperframes/bin/hyperframes.mjs');
  run(process.execPath,[cli,'lint',stage],'Hyperframes composition lint');
  run(process.execPath,[cli,'render',stage,'--output',join(output,'jk-operation.mp4'),'--fps','24','--workers','1','--quality','standard','--no-browser-gpu'],'Hyperframes MP4 render');
  run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss','1.8','-i',join(output,'jk-operation.mp4'),'-frames:v','1','-update','1',join(output,'jk-operation-poster.png')],'FFmpeg poster extraction');
  run('ffprobe',['-v','error','-show_entries','format=duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels','-of','json',join(output,'jk-operation.mp4')],'FFprobe output verification');
  passed=true;
} finally {
  const files=[];
  for(const name of (await readdir(output,{withFileTypes:true})).filter(entry=>entry.isFile()&&!entry.name.endsWith('.part')).map(entry=>entry.name).sort()) {
    const bytes=await readFile(join(output,name));
    files.push({file:`outputs/${name}`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  await writeFile(join(evidence,'render-receipt.json'),JSON.stringify({date:new Date().toISOString(),passed,applicationRuntimeChanged:false,externalProvidersCalled:false,commands,files},null,2)+'\n');
  await rm(stage,{recursive:true,force:true});
}
