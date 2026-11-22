'use strict';
/* Funkraum – clock for the screen sharing (share.js). Timers of hidden tabs
 * are slowed down to once per second; a worker's timers are not, so the
 * screen keeps its frame rate while you look at another window. */
let timer = null;
onmessage = (e) => {
  if (timer) clearInterval(timer);
  timer = null;
  const ms = e.data && e.data.ms;
  if (ms > 0) timer = setInterval(() => postMessage(0), ms);
};
