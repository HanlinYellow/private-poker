
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(__filename),'..');
const publicDir=path.join(root,'server','public');

fs.rmSync(publicDir,{recursive:true,force:true});
fs.mkdirSync(publicDir,{recursive:true});

fs.copyFileSync(path.join(root,'launcher','index.html'),path.join(publicDir,'index.html'));

const games=[
  ['zhajinhua','zjh'],
  ['holdem-long','long'],
  ['holdem-short','short']
];

for(const [folder,slug] of games){
  const src=path.join(root,folder,'client','dist');
  const dst=path.join(publicDir,'games',slug);
  if(!fs.existsSync(src))throw new Error(`Missing build output: ${src}`);
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  fs.cpSync(src,dst,{recursive:true});
}

console.log('Assembled static site into server/public');
