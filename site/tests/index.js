// Makes `node --test site/tests/` work on Node >= 21, which resolves a directory argument as
// a module (this file) instead of searching it for test files. Older Node versions search
// the directory and never load this file.
import('./frame.test.mjs');
import('./overlays.test.mjs');
