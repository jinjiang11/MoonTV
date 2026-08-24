import { FragmentCodecAnalyzer } from './codecAnalyzer';
import { extractH264CodecFingerprint } from './transportStreamAnalyzer';

function tsPacket(
  pid: number,
  payloadUnitStart: boolean,
  payload: number[]
): Uint8Array {
  if (payload.length > 183) throw new Error('Test payload is too large');

  const packet = new Uint8Array(188);
  packet.fill(0xff);
  packet[0] = 0x47;
  packet[1] = (payloadUnitStart ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  packet[2] = pid & 0xff;
  packet[3] = 0x30;

  const adaptationLength = 183 - payload.length;
  packet[4] = adaptationLength;
  if (adaptationLength > 0) packet[5] = 0;
  packet.set(payload, 5 + adaptationLength);
  return packet;
}

function testTransportStream(sps: number[]): Uint8Array {
  const pat = tsPacket(
    0,
    true,
    [
      0, 0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0, 0x10,
      0, 0, 0, 0,
    ]
  );
  const pmt = tsPacket(
    0x10,
    true,
    [
      0, 0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x00, 0xf0, 0x00,
      0x1b, 0xe1, 0x00, 0xf0, 0x00, 0, 0, 0, 0,
    ]
  );
  const video = tsPacket(0x100, true, [
    0x00,
    0x00,
    0x01,
    0xe0,
    0x00,
    0x00,
    0x80,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x67,
    ...sps,
    0x00,
    0x00,
    0x00,
    0x01,
    0x68,
    0xce,
    0x06,
    0xe2,
    0x00,
    0x00,
    0x00,
    0x01,
    0x09,
    0xf0,
  ]);

  const result = new Uint8Array(pat.length + pmt.length + video.length);
  result.set(pat, 0);
  result.set(pmt, pat.length);
  result.set(video, pat.length + pmt.length);
  return result;
}

describe('H.264 transport-stream fingerprinting', () => {
  it('returns stable signatures and distinguishes different SPS data', () => {
    const programme = testTransportStream([0x64, 0x00, 0x28, 0xac]);
    const insertedClip = testTransportStream([0x64, 0x00, 0x28, 0xad]);

    const programmeFingerprint = extractH264CodecFingerprint(programme);
    expect(programmeFingerprint).toBeTruthy();
    expect(extractH264CodecFingerprint(programme)).toBe(programmeFingerprint);
    expect(extractH264CodecFingerprint(insertedClip)).not.toBe(
      programmeFingerprint
    );
  });

  it('ignores data that is not an MPEG-TS H.264 fragment', () => {
    expect(extractH264CodecFingerprint(new Uint8Array(600))).toBeNull();
  });
});

describe('FragmentCodecAnalyzer', () => {
  it('detects the codec switch in the ad at 40:10.52', () => {
    const analyzer = new FragmentCodecAnalyzer();

    analyzer.observe({
      start: 2408.64,
      duration: 1.88,
      fingerprint: 'programme',
    });
    analyzer.observe({
      start: 2410.52,
      duration: 2.8,
      fingerprint: 'inserted-clip',
      uri: 'https://media.example/5NYcL0sG.ts',
    });
    analyzer.observe({
      start: 2413.32,
      duration: 1.96,
      fingerprint: 'inserted-clip',
      uri: 'https://media.example/4uifa7cl.ts',
    });

    const candidate = analyzer.observe({
      start: 2430.4,
      duration: 2,
      fingerprint: 'programme',
    });

    expect(candidate).toMatchObject({
      start: 2410.52,
      end: 2430.4,
      confidence: 0.82,
      segmentUris: [
        'https://media.example/5NYcL0sG.ts',
        'https://media.example/4uifa7cl.ts',
      ],
    });
    expect(candidate?.duration).toBeCloseTo(19.88);
    expect(candidate?.evidence.map((item) => item.type)).toContain(
      'codec-switch'
    );
  });

  it('does not report a one-fragment or permanent codec change', () => {
    const oneFragment = new FragmentCodecAnalyzer();
    oneFragment.observe({
      start: 0,
      duration: 2,
      fingerprint: 'programme',
    });
    oneFragment.observe({
      start: 10,
      duration: 2,
      fingerprint: 'inserted-clip',
    });
    expect(
      oneFragment.observe({
        start: 12,
        duration: 2,
        fingerprint: 'programme',
      })
    ).toBeNull();

    const permanent = new FragmentCodecAnalyzer();
    permanent.observe({
      start: 0,
      duration: 2,
      fingerprint: 'programme',
    });
    permanent.observe({
      start: 10,
      duration: 2,
      fingerprint: 'new-encode',
    });
    expect(
      permanent.observe({
        start: 12,
        duration: 2,
        fingerprint: 'new-encode',
      })
    ).toBeNull();
  });
});
