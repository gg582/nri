export function validateRequest(input: unknown): string {
  if (input === undefined || input === null) {
    throw new Error('No request was provided. A textual request with actionable content is required.');
  }

  const text = String(input).trim();

  if (text.length === 0) {
    throw new Error('Request cannot be empty or whitespace-only.');
  }

  if (/^\\+$/.test(text)) {
    throw new Error('Request cannot consist only of backslashes.');
  }

  return text;
}
