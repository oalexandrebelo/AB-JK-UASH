/** Formats a value without guessing ambiguous OCR characters (O/0, I/1, etc.). */
export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}

/** Standard Brazilian passenger-vehicle layouts: ABC1234 and ABC1D23. */
export function isValidPlate(value: string): boolean {
  return /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(normalizePlate(value));
}

/** Only whole candidates are returned; unrelated characters are never substituted. */
export function extractPlateCandidates(text: string): string[] {
  const matches = text.toUpperCase().matchAll(/(?:^|[^A-Z0-9])([A-Z]{3}[\s-]?[0-9][\s-]?[A-Z0-9][\s-]?[0-9]{2})(?=$|[^A-Z0-9])/g);
  return [...new Set([...matches].map((match) => normalizePlate(match[1])))];
}
