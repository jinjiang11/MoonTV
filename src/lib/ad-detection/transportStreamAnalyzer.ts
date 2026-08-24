const MPEG_TS_PACKET_SIZE = 188;
const MAX_VIDEO_BYTES_TO_SCAN = 256 * 1024;

function toUint8Array(payload: unknown): Uint8Array | null {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (!ArrayBuffer.isView(payload)) return null;

  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
}

function findSyncOffset(data: Uint8Array): number {
  const limit = Math.min(MPEG_TS_PACKET_SIZE, data.length);

  for (let offset = 0; offset < limit; offset++) {
    if (
      data[offset] === 0x47 &&
      data[offset + MPEG_TS_PACKET_SIZE] === 0x47 &&
      data[offset + MPEG_TS_PACKET_SIZE * 2] === 0x47
    ) {
      return offset;
    }
  }

  return -1;
}

function payloadOffset(data: Uint8Array, packetStart: number): number | null {
  const packetEnd = packetStart + MPEG_TS_PACKET_SIZE;
  const adaptationFieldControl = (data[packetStart + 3] >> 4) & 0x03;
  if (adaptationFieldControl === 0 || adaptationFieldControl === 2) return null;

  let offset = packetStart + 4;
  if (adaptationFieldControl === 3) {
    offset += 1 + data[offset];
  }

  return offset < packetEnd ? offset : null;
}

function psiSectionOffset(
  data: Uint8Array,
  packetStart: number,
  offset: number
): number | null {
  if ((data[packetStart + 1] & 0x40) === 0) return null;

  const sectionOffset = offset + 1 + data[offset];
  return sectionOffset + 3 <= packetStart + MPEG_TS_PACKET_SIZE
    ? sectionOffset
    : null;
}

function findProgramMapPid(data: Uint8Array, syncOffset: number): number {
  for (
    let packetStart = syncOffset;
    packetStart + MPEG_TS_PACKET_SIZE <= data.length;
    packetStart += MPEG_TS_PACKET_SIZE
  ) {
    const pid = ((data[packetStart + 1] & 0x1f) << 8) | data[packetStart + 2];
    if (pid !== 0) continue;

    const offset = payloadOffset(data, packetStart);
    if (offset === null) continue;

    const sectionOffset = psiSectionOffset(data, packetStart, offset);
    if (sectionOffset === null || data[sectionOffset] !== 0x00) continue;

    const sectionLength =
      ((data[sectionOffset + 1] & 0x0f) << 8) | data[sectionOffset + 2];
    const sectionEnd = sectionOffset + 3 + sectionLength - 4;
    const packetEnd = packetStart + MPEG_TS_PACKET_SIZE;
    if (sectionEnd > packetEnd) continue;

    for (let index = sectionOffset + 8; index + 4 <= sectionEnd; index += 4) {
      const programNumber = (data[index] << 8) | data[index + 1];
      if (programNumber !== 0) {
        return ((data[index + 2] & 0x1f) << 8) | data[index + 3];
      }
    }
  }

  return -1;
}

function findH264Pid(
  data: Uint8Array,
  syncOffset: number,
  programMapPid: number
): number {
  for (
    let packetStart = syncOffset;
    packetStart + MPEG_TS_PACKET_SIZE <= data.length;
    packetStart += MPEG_TS_PACKET_SIZE
  ) {
    const pid = ((data[packetStart + 1] & 0x1f) << 8) | data[packetStart + 2];
    if (pid !== programMapPid) continue;

    const offset = payloadOffset(data, packetStart);
    if (offset === null) continue;

    const sectionOffset = psiSectionOffset(data, packetStart, offset);
    if (sectionOffset === null || data[sectionOffset] !== 0x02) continue;

    const sectionLength =
      ((data[sectionOffset + 1] & 0x0f) << 8) | data[sectionOffset + 2];
    const sectionEnd = sectionOffset + 3 + sectionLength - 4;
    const packetEnd = packetStart + MPEG_TS_PACKET_SIZE;
    if (sectionEnd > packetEnd || sectionOffset + 12 > sectionEnd) continue;

    const programInfoLength =
      ((data[sectionOffset + 10] & 0x0f) << 8) | data[sectionOffset + 11];

    for (
      let index = sectionOffset + 12 + programInfoLength;
      index + 5 <= sectionEnd;

    ) {
      const streamType = data[index];
      const elementaryPid = ((data[index + 1] & 0x1f) << 8) | data[index + 2];
      const streamInfoLength =
        ((data[index + 3] & 0x0f) << 8) | data[index + 4];

      if (streamType === 0x1b) return elementaryPid;
      index += 5 + streamInfoLength;
    }
  }

  return -1;
}

function collectVideoPayload(
  data: Uint8Array,
  syncOffset: number,
  videoPid: number
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for (
    let packetStart = syncOffset;
    packetStart + MPEG_TS_PACKET_SIZE <= data.length &&
    totalLength < MAX_VIDEO_BYTES_TO_SCAN;
    packetStart += MPEG_TS_PACKET_SIZE
  ) {
    const pid = ((data[packetStart + 1] & 0x1f) << 8) | data[packetStart + 2];
    if (pid !== videoPid) continue;

    let offset = payloadOffset(data, packetStart);
    if (offset === null) continue;

    const packetEnd = packetStart + MPEG_TS_PACKET_SIZE;
    const payloadUnitStart = (data[packetStart + 1] & 0x40) !== 0;
    if (
      payloadUnitStart &&
      offset + 9 <= packetEnd &&
      data[offset] === 0x00 &&
      data[offset + 1] === 0x00 &&
      data[offset + 2] === 0x01
    ) {
      offset += 9 + data[offset + 8];
    }

    if (offset >= packetEnd) continue;
    const chunk = data.subarray(offset, packetEnd);
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let writeOffset = 0;
  chunks.forEach((chunk) => {
    result.set(chunk, writeOffset);
    writeOffset += chunk.length;
  });
  return result;
}

function startCodeLength(data: Uint8Array, offset: number): number {
  if (
    data[offset] === 0x00 &&
    data[offset + 1] === 0x00 &&
    data[offset + 2] === 0x01
  ) {
    return 3;
  }

  if (
    data[offset] === 0x00 &&
    data[offset + 1] === 0x00 &&
    data[offset + 2] === 0x00 &&
    data[offset + 3] === 0x01
  ) {
    return 4;
  }

  return 0;
}

function bytesToHex(data: Uint8Array): string {
  let result = '';
  for (let index = 0; index < data.length; index++) {
    result += data[index].toString(16).padStart(2, '0');
  }
  return result;
}

function codecFingerprint(elementaryStream: Uint8Array): string | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;

  for (let offset = 0; offset + 5 < elementaryStream.length; offset++) {
    const prefixLength = startCodeLength(elementaryStream, offset);
    if (prefixLength === 0) continue;

    const nalStart = offset + prefixLength;
    const nalType = elementaryStream[nalStart] & 0x1f;
    if (nalType !== 7 && nalType !== 8) continue;

    let nalEnd = nalStart + 1;
    while (
      nalEnd + 4 < elementaryStream.length &&
      startCodeLength(elementaryStream, nalEnd) === 0
    ) {
      nalEnd++;
    }

    const nal = elementaryStream.slice(nalStart, nalEnd);
    if (nalType === 7 && !sps) sps = nal;
    if (nalType === 8 && !pps) pps = nal;
    if (sps && pps) break;
    offset = nalEnd - 1;
  }

  if (!sps) return null;
  return `${bytesToHex(sps)}:${pps ? bytesToHex(pps) : ''}`;
}

/**
 * Extract the H.264 SPS/PPS signature from an MPEG-TS media fragment.
 * Only the beginning of the video payload is inspected and the source buffer
 * is never copied in full, keeping the per-fragment overhead small.
 */
export function extractH264CodecFingerprint(payload: unknown): string | null {
  const data = toUint8Array(payload);
  if (!data || data.length < MPEG_TS_PACKET_SIZE * 3) return null;

  const syncOffset = findSyncOffset(data);
  if (syncOffset < 0) return null;

  const programMapPid = findProgramMapPid(data, syncOffset);
  if (programMapPid < 0) return null;

  const videoPid = findH264Pid(data, syncOffset, programMapPid);
  if (videoPid < 0) return null;

  return codecFingerprint(collectVideoPayload(data, syncOffset, videoPid));
}
