/**
 * Names files pasted from the clipboard. Screenshots arrive as a generic "image.png" (or with
 * no name at all), so they get a timestamped name; when one paste carries several generic
 * files (multi-file copy from Finder/Explorer, some screenshot tools), a per-file sequence
 * suffix keeps them distinguishable — the timestamp alone is second-precision and would
 * collide within the batch. Files that already have real names pass through unchanged.
 */
export function nameClipboardFiles(files: File[]): File[] {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const isGeneric = (f: File) => !f.name || f.name === 'image.png';
  const genericCount = files.filter(isGeneric).length;
  let seq = 0;
  return files.map((f) => {
    if (!isGeneric(f)) return f;
    const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    seq += 1;
    const suffix = genericCount > 1 ? `-${seq}` : '';
    return new File([f], `pasted-${ts}${suffix}.${ext}`, { type: f.type });
  });
}
