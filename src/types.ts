export type Orientation = "vertical" | "horizontal";

export type MockupKind = "psd" | "image";

export interface MockupItem {
  id: string;
  filename: string;
  originalName: string;
  kind: MockupKind;
  mime: string;
  size: number;
  uploadedAt: string;
}

export interface MockupLists {
  vertical: MockupItem[];
  horizontal: MockupItem[];
}
