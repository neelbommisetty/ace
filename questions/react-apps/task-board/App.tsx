import type { ReactElement } from 'react';

export interface Task {
  id: string;
  title: string;
  done: boolean;
}

export type Filter = 'all' | 'active' | 'done';

export default function App(): ReactElement {
  // TODO: implement — delete the throw below and build the board.
  throw new Error('App is not implemented yet');
}
