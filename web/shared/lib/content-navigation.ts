/** Only reading routes may be a return destination; never external navigation. */
export function contentReturn(value: string | null | undefined, fallback = '#/documents'): string {
  return value &&
    value.length <= 16000 &&
    !/[\r\n]/.test(value) &&
    /^#\/(?:questions|documents|papers|learning-reader)(?:[/?]|$)/.test(value)
    ? value
    : fallback;
}
