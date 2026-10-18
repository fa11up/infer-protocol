// infer.imdusd.com's sound button with its score: loaded after the page is drawn (lazy-sound.tsx, infer/ui.tsx),
// since the score and its voices are code no first paint needs.
import { useEffect } from "react";
import { Sound, player } from "./score";
import { INFER_SCORE } from "./infer/score";

export default function SoundInfer({ takeAsked }: { takeAsked: () => boolean }) {
  useEffect(() => {
    // The visitor pressed the button before this code arrived: that press turns the sound on now.
    if (takeAsked()) player(INFER_SCORE).toggle();
  }, [takeAsked]);
  return <Sound score={INFER_SCORE} />;
}
