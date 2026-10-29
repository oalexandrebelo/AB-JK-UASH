import {useEffect, useId, useRef, useState} from 'react';
import {Button} from '@react-spectrum/s2/Button';
import {FileTrigger} from '@react-spectrum/s2/FileTrigger';
import {ProgressBar} from '@react-spectrum/s2/ProgressBar';
import {TextField} from '@react-spectrum/s2/TextField';
import {recognizePlate} from './client';
import type {PlateOcrProgress, PlateOcrResult} from './client';
import {inspectImageFile} from './image';
import {isValidPlate, normalizePlate} from './plate';
import './plate-reader.css';

export interface PlateReaderProps {
  onPlate: (plate: string) => void;
}

/** Local OCR is a suggestion only. The parent receives a plate after human review. */
export default function PlateReader({onPlate}: PlateReaderProps) {
  const headingId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlateOcrResult | null>(null);
  const [candidate, setCandidate] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState<PlateOcrProgress>({label: 'Preparando a foto…', percent: 0});
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);
  useEffect(() => {
    if (!file) {
      setPreview('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function selectFile(selected?: File | null) {
    if (!selected) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(false);
    setFile(null);
    setResult(null);
    setCandidate('');
    setError('');
    setNotice('');
    try {
      await inspectImageFile(selected, controller.signal);
      if (!controller.signal.aborted) setFile(selected);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Não foi possível abrir a foto.');
    }
  }

  async function read() {
    if (!file || busy) return;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setResult(null);
    setCandidate('');
    setError('');
    setNotice('');
    try {
      const reading = await recognizePlate(file, {
        signal: controller.signal,
        onProgress: (value) => { if (!controller.signal.aborted) setProgress(value); }
      });
      if (controller.signal.aborted) return;
      setResult(reading);
      setCandidate(reading.candidates[0] ?? '');
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Não foi possível ler a placa.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function cancel() {
    operation.current?.abort();
    setBusy(false);
    setNotice('Leitura cancelada. Você pode tentar novamente ou digitar a placa no cadastro.');
  }

  function confirm() {
    if (!isValidPlate(candidate)) return;
    onPlate(normalizePlate(candidate));
    setNotice('Placa conferida e preenchida no cadastro.');
  }

  return (
    <section className="plate-reader" aria-labelledby={headingId}>
      <div className="plate-reader-heading">
        <h3 id={headingId}>Ler placa de uma foto</h3>
        <span className="plate-reader-local">Leitura local</span>
      </div>
      <p className="plate-reader-hint">Escolha uma foto nítida, recortada ao redor da placa e sem reflexos. A imagem é processada neste navegador.</p>
      <div className="plate-reader-actions">
        <FileTrigger acceptedFileTypes={['image/png', 'image/jpeg']} onSelect={(files) => void selectFile(files?.item(0))}>
          <Button variant="secondary" size="S" isDisabled={busy}>{file ? 'Trocar foto' : 'Selecionar foto'}</Button>
        </FileTrigger>
        {file && !busy && <Button variant="secondary" size="S" onPress={() => void read()}>Ler placa</Button>}
        {busy && <Button variant="secondary" size="S" onPress={cancel}>Cancelar leitura</Button>}
        <span className="plate-reader-format">PNG ou JPEG · até 10 MB</span>
      </div>
      {preview && <div className="plate-reader-preview"><img src={preview} alt="Foto selecionada para conferir a placa" /></div>}
      {busy && <ProgressBar label={progress.label} value={progress.percent} />}
      {error && <p className="plate-reader-error" role="alert">{error}</p>}
      {result && <div className="plate-reader-result">
        <p className="plate-reader-confidence">Confiança estimada pelo OCR: <strong>{Math.round(result.confidence)}%</strong>. Confira cada caractere antes de usar.</p>
        {!result.candidates.length && <p className="plate-reader-hint">Não foi possível identificar uma placa no padrão esperado. Tente uma foto mais próxima ou preencha o campo abaixo.</p>}
        {result.text && <p className="plate-reader-raw">Texto lido: <span>{result.text.slice(0, 80)}</span></p>}
        {result.candidates.length > 1 && <div className="plate-reader-actions" aria-label="Placas encontradas">
          {result.candidates.map((plate) => <Button key={plate} variant="secondary" size="S" onPress={() => setCandidate(plate)}>{plate}</Button>)}
        </div>}
        <TextField label="Placa para conferência" value={candidate} onChange={(value) => setCandidate(value.toUpperCase())}
          maxLength={9} autoComplete="off" spellCheck="false" description="Formatos aceitos: ABC1234 ou ABC1D23."
          isInvalid={candidate.length > 0 && !isValidPlate(candidate)} errorMessage="Confira os sete caracteres da placa." />
        <div className="plate-reader-actions"><Button variant="secondary" size="S" isDisabled={!isValidPlate(candidate)} onPress={confirm}>Usar placa conferida</Button></div>
      </div>}
      {notice && <p className="plate-reader-hint" role="status">{notice}</p>}
    </section>
  );
}
