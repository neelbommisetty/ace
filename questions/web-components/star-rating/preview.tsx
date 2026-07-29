import { useState } from 'react';
import { StarRating } from './Component';

// Seeded preview fixture (NEE-352) — this file is yours: edit the props
// freely. StarRating is fully controlled, so the preview holds its own piece
// of state and passes it back through `value`/`onChange` — a static prop
// object would render a rating that can never move.
export default function Preview() {
  const [value, setValue] = useState(3);
  return <StarRating value={value} onChange={setValue} label="Order rating" />;
}
