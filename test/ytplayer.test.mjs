import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeLink } from '../public/js/ytplayer.js';

test('parses YouTube Music and YouTube links', () => {
  assert.deepEqual(parseYouTubeLink('https://music.youtube.com/playlist?list=PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i'), { list: 'PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i', video: null });
  assert.deepEqual(parseYouTubeLink('https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ'), { list: 'RDAMVMdQw4w9WgXcQ', video: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeLink('https://music.youtube.com/browse/VLPL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i?si=x'), { list: 'PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i', video: null });
  assert.deepEqual(parseYouTubeLink('https://youtu.be/dQw4w9WgXcQ?si=abc'), { list: null, video: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { list: null, video: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeLink('m.youtube.com/shorts/dQw4w9WgXcQ'), { list: null, video: 'dQw4w9WgXcQ' });
  assert.deepEqual(parseYouTubeLink('OLAK5uy_kX3nQd2aR7vYbW1cZ8eF0gH4iJ5kL6mN7'), { list: 'OLAK5uy_kX3nQd2aR7vYbW1cZ8eF0gH4iJ5kL6mN7', video: null });
  assert.equal(parseYouTubeLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), null);
  assert.equal(parseYouTubeLink('hello'), null);
});
