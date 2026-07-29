import type { ReactElement } from 'react';

export interface StarRatingProps {
  /** Current rating, 0 = unrated. */
  value: number;
  /** Called with the next rating. Never called in readOnly mode. */
  onChange: (next: number) => void;
  /** Number of stars. Defaults to 5. */
  max?: number;
  /** Accessible name for the group. */
  label: string;
  /** Renders the current value but refuses all input. Defaults to false. */
  readOnly?: boolean;
}

export function StarRating(props: StarRatingProps): ReactElement {
  // TODO: implement — delete the throw below and render the radiogroup.
  void props;
  throw new Error('StarRating is not implemented yet');
}
