import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';import path from 'node:path';import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),require=createRequire(path.join(process.env.PAPERS_SOURCE||path.resolve(here,'../../../PapersCrossDeviceSource'),'package.json'));
await require('esbuild').build({entryPoints:[path.join(here,'editor.jsx')],outfile:path.join(here,'../../public/appflowy-editor.js'),bundle:true,minify:true,format:'iife',platform:'browser',target:'es2020',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof',banner:{js:'/*! '+await readFile(path.join(here,'../../public/appflowy-NOTICES.txt'),'utf8')+' */'}});
