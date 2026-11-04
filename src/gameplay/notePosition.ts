export type NoteLayout = 'vertical' | 'horizontal';

export function getNotePosition(layout: NoteLayout, secondsToHit: number): number {
  return layout === 'vertical'
    ? 80 - (secondsToHit / 4) * 100
    : 18 + secondsToHit * 22;
}
