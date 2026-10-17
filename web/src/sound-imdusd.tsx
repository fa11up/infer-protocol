// imdusd.com's sound button with its score: loaded after the page is drawn (site.tsx LazySound), since the
// score and its voices are code no first paint needs.
import { useEffect } from "react";
import { Sound, player } from "./score";
import { IMDUSD_SCORE } from "./score-imdusd";

export default function SoundImdusd({ takeAsked }: { takeAsked: () => boolean }) {
  useEffect(() => {
    // The visitor pressed the button before this code arrived: that press turns the sound on now.
    if (takeAsked()) player(IMDUSD_SCORE).toggle();
  }, [takeAsked]);
  return <Sound score={IMDUSD_SCORE} />;
}
