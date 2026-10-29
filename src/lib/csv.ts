/** Quote every cell and prevent spreadsheets from interpreting untrusted text as a formula. */
export function csvCell(value: unknown): string {
  const text=String(value??'');
  const safe=/^(?=[\s]*[=+@-]|[\t\r\n])/.test(text)?`'${text}`:text;
  return `"${safe.replaceAll('"','""')}"`;
}
