/**
 * Books I'm reading right now, shown first on the /reading shelf.
 * Covers live in public/covers/current/. When one is finished, remove it here
 * and add it to src/content/bookshelf/.
 */
export interface NowReading {
  title: string;
  author: string;
  cover: string;
  /** Spine color, #rrggbb */
  color: string;
  pages: number;
  /** Spine height on the shelf, 90–180 */
  height: number;
}

export const nowReading: NowReading[] = [
  {
    title: 'The Savage Detectives',
    author: 'Roberto Bolaño',
    cover: '/covers/current/the-savage-detectives.jpg',
    color: '#f1efea',
    pages: 577,
    height: 172,
  },
  {
    title: 'The Master and Margarita',
    author: 'Mikhail Bulgakov',
    cover: '/covers/current/the-master-and-margarita.jpg',
    color: '#b8432f',
    pages: 432,
    height: 166,
  },
  {
    title: 'Either/Or',
    author: 'Søren Kierkegaard',
    cover: '/covers/current/either-or-kierkegaard.jpg',
    color: '#1f1c1a',
    pages: 640,
    height: 160,
  },
];
