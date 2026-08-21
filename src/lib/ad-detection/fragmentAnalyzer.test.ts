import { FragmentTrackAnalyzer } from './fragmentAnalyzer';

describe('FragmentTrackAnalyzer', () => {
  it('detects the temporary resolution switch in the supplied missed ad', () => {
    const analyzer = new FragmentTrackAnalyzer();

    expect(
      analyzer.observe({
        start: 0,
        duration: 4,
        width: 1920,
        height: 804,
      })
    ).toBeNull();
    expect(
      analyzer.observe({
        start: 523.72,
        duration: 4,
        width: 1280,
        height: 720,
        uri: 'https://media.example/ad-1.ts',
      })
    ).toBeNull();

    const candidate = analyzer.observe({
      start: 544.72,
      duration: 4,
      width: 1920,
      height: 804,
    });

    expect(candidate).toMatchObject({
      start: 523.72,
      end: 544.72,
      duration: 21,
      confidence: 0.85,
      segmentUris: ['https://media.example/ad-1.ts'],
    });
    expect(candidate?.evidence.map((item) => item.type)).toContain(
      'resolution-switch'
    );
  });

  it('does not report a permanent resolution change', () => {
    const analyzer = new FragmentTrackAnalyzer();

    analyzer.observe({ start: 0, duration: 4, width: 1920, height: 804 });
    analyzer.observe({ start: 20, duration: 4, width: 1280, height: 720 });

    expect(
      analyzer.observe({ start: 40, duration: 4, width: 1280, height: 720 })
    ).toBeNull();
  });

  it('rejects temporary switches longer than the heuristic limit', () => {
    const analyzer = new FragmentTrackAnalyzer();

    analyzer.observe({ start: 0, duration: 4, width: 1920, height: 804 });
    analyzer.observe({ start: 20, duration: 4, width: 1280, height: 720 });

    expect(
      analyzer.observe({ start: 201, duration: 4, width: 1920, height: 804 })
    ).toBeNull();
  });

  it('can be reset between videos', () => {
    const analyzer = new FragmentTrackAnalyzer();

    analyzer.observe({ start: 0, duration: 4, width: 1920, height: 804 });
    analyzer.observe({ start: 20, duration: 4, width: 1280, height: 720 });
    analyzer.reset();

    expect(
      analyzer.observe({ start: 40, duration: 4, width: 1920, height: 804 })
    ).toBeNull();
  });
});
