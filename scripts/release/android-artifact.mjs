/** Bind the SDK verification result to the exact signed APK bytes. */
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

export function validateAndroidSignatureProof(proof, artifact, name) {
  if (!proof || proof.signed !== true || proof.signatureVerified !== true || proof.alignmentVerified !== true
    || proof.schemes?.v2 !== true || proof.apk !== name || proof.sha256 !== artifact.sha256 || proof.bytes !== artifact.bytes
    || !/^[a-f0-9]{64}$/.test(proof.certificateSha256 || '') || proof.certificate?.sha256 !== proof.certificateSha256) {
    throw new Error('正式 APK 的签名验证记录不匹配，请重新构建并验证');
  }
  return { certificateSha256: proof.certificateSha256, schemes: Object.fromEntries(['v1','v2','v3','v31','v4'].map(key=>[key,proof.schemes[key]===true])) };
}

export async function collectSignedAndroidArtifact({root, output, version}) {
  const source=join(root,'artifacts/noetic-atlas-release.apk');
  const bytes=await readFile(source);
  const artifact={file:`noetic-atlas-${version}-android.apk`,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),signingReport:'android-signing-report.json'};
  const proof=JSON.parse(await readFile(join(root,'artifacts/android-signing-report.json'),'utf8'));
  const signature=validateAndroidSignatureProof(proof,artifact,basename(source));
  await copyFile(source,join(output,artifact.file));
  if(createHash('sha256').update(await readFile(join(output,artifact.file))).digest('hex')!==artifact.sha256) throw new Error('复制期间正式 APK 发生变化');
  await writeFile(join(output,artifact.signingReport),JSON.stringify({...proof,apk:artifact.file},null,2)+'\n');
  return {artifact,signature};
}
