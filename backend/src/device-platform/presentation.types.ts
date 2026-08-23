export interface PresentationManifest {
  deviceId: number;
  externalId: string;
  revision: number;
  generatedAt: string;
  nextTransitionAt: string | null;
  content: {
    kind: 'image';
    url: string;
    title: string;
    fit: 'contain' | 'cover' | 'fill';
    background: string;
  };
  viewport: {
    width: number;
    height: number;
  };
}
