/** wm reports dimensions in the device's natural orientation, which can be a
 * landscape tablet/emulator. Rotation 0 must not be assumed to be portrait. */
export function androidLayoutProfiles(size) {
  const selected =
    size.match(/Override size:\s*(\d+)x(\d+)/) || size.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!selected || Number(selected[1]) <= 0 || Number(selected[2]) <= 0)
    throw Error('Cannot determine Android natural display dimensions');
  const portraitRotation = Number(selected[1]) > Number(selected[2]) ? 1 : 0;
  return [
    { name: 'portrait', rotation: portraitRotation, font: '1.0' },
    { name: 'landscape', rotation: portraitRotation === 0 ? 1 : 0, font: '1.0' },
    { name: 'large-font', rotation: portraitRotation, font: '1.3' },
  ];
}
