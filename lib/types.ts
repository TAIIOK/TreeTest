export type Span = {
  line: number;
  start: number;
  end: number;
  text: string;
};

export type StepMark = {
  line: number;
  start: number;
  end: number;
  step: number;
};

export type PublicSession = {
  id: string;
  source: string;
  totalSteps: number;
  cursor: number;
  done: boolean;
  marks: StepMark[];
  targets: Span[];
  taskTitle: string;
};

export type ClickSuccess = {
  ok: true;
  cursor: number;
  totalSteps: number;
  done: boolean;
  marks: StepMark[];
};

export type ClickFailure = {
  ok: false;
  cursor: number;
  totalSteps: number;
  clickedLine: number;
  clickedStart: number;
  clickedEnd: number;
  correctLine: number;
  correctStart: number;
  correctEnd: number;
  correctText: string;
  fallback: string;
  token: string;
};
