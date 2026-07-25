// Update the existing `promptNRI` function in this file. Leave all other exports unchanged.
function sanitizeNewlines(value: string): string {
  // Replace any newline sequence with a single space so the TUI cannot break on embedded newlines.
  return value.replace(/\r?\n/g, ' ');
}

export async function promptNRI(): Promise<string> {
  // Assumes `prompts` is already imported in this module.
  const { nri } = await prompts({
    type: 'text',
    name: 'nri',
    message: 'NRI input',
    multiline: false, // Single Enter submits; double Enter is no longer required.
    // If an existing `validate` option exists, keep it and apply it to `sanitizeNewlines(value)`.
  });

  return sanitizeNewlines(nri as string);
}
