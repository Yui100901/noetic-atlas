/** Disposable read models, shared with complete-backup recovery validation. */
export const READ_PROJECTION_VERSION = '7';
export const SUPPORTED_READ_PROJECTION_VERSIONS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  READ_PROJECTION_VERSION,
] as const;
