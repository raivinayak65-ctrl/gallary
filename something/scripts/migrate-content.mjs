import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'memory-constellation.html');
const publicDir = path.join(root, 'public');
const privateDir = path.join(root, 'private-assets');
const dataDir = path.join(root, 'data');
const html = await readFile(sourcePath, 'utf8');
const start = html.indexOf('const memories = [');
const end = html.indexOf('\n];\n\nconst prefersReducedMotion', start);
if (start === -1 || end === -1) throw new Error('Could not locate the memory list.');

const memoryCode = html.slice(start, end + 3).replace('const memories =', 'globalThis.memories =');
const context = {};
vm.runInNewContext(memoryCode, context, { timeout: 1000 });
const seededMemories = [];

await Promise.all([mkdir(publicDir, { recursive: true }), mkdir(privateDir, { recursive: true }), mkdir(dataDir, { recursive: true })]);
for (const memory of context.memories) {
  const owner = memory.person.trim().toLowerCase();
  const ownerDir = path.join(privateDir, owner);
  await mkdir(ownerDir, { recursive: true });
  let extension = 'jpg';
  let output;
  if (memory.img.startsWith('data:image/')) {
    const [header, encoded] = memory.img.split(',', 2);
    extension = header.match(/^data:image\/([a-zA-Z0-9+.-]+);base64$/)?.[1] || 'jpg';
    output = Buffer.from(encoded, 'base64');
  } else {
    extension = path.extname(memory.img).slice(1) || 'jpg';
    const sourceImage = path.join(root, memory.img);
    output = await readFile(sourceImage);
  }
  const privatePath = path.join(ownerDir, `${memory.id}.${extension}`);
  if (!existsSync(privatePath)) await writeFile(privatePath, output);
  seededMemories.push({
    id: memory.id,
    owner,
    displayName: memory.person,
    title: memory.title,
    year: memory.year,
    color: memory.color,
    imagePath: path.relative(privateDir, privatePath).replaceAll('\\', '/')
  });
}
await writeFile(path.join(dataDir, 'seed-memories.json'), JSON.stringify(seededMemories, null, 2));

const apiStorage = `let captionCache = {};
async function loadCaptions(){
  const response = await fetch('/api/captions');
  return response.ok ? response.json() : {};
}
async function saveCaption(id, text){
  await fetch('/api/memories/' + encodeURIComponent(id) + '/caption', {
    method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text })
  });
}`;
const clientAuth = `const passwordInput = document.getElementById('password-input');
const visitorNote = document.getElementById('visitor-note');

async function authenticate(name, password){
  const response = await fetch('/api/auth', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name, password })
  });
  const result = await response.json();
  if(!response.ok) throw new Error(result.error || 'Unable to sign in.');
  return result;
}
async function loadMemories(){
  const response = await fetch('/api/memories');
  if(!response.ok) throw new Error('Unable to load your memories.');
  memories = await response.json();
}
`;
const clientFlow = `nameForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = nameInput.value.trim();
  const password = passwordInput.value;
  if(!name){ nameHint.textContent = 'tell us who you are first'; return; }
  if(password.length < 6){ nameHint.textContent = 'use a password with at least 6 characters'; passwordInput.focus(); return; }
  const submit = nameForm.querySelector('button');
  submit.disabled = true; nameHint.textContent = '';
  try{
    const access = await authenticate(name, password);
    await loadMemories();
    captionCache = await loadCaptions();
    buildConstellation(access.name);
    const photoCount = memories.length;
    document.getElementById('greeting-line1').textContent = access.created ? 'your password is set,' : 'welcome back,';
    document.getElementById('greeting-line2').textContent = access.name;
    document.querySelector('#top-bar .title').textContent = access.name + "'s constellation";
    document.getElementById('hint-bar').textContent = photoCount
      ? 'tap a star to open it · ' + photoCount + ' photo' + (photoCount === 1 ? '' : 's') + ' in your constellation'
      : 'no photos have been added to your constellation yet';
    visitorNote.textContent = photoCount
      ? photoCount + ' memor' + (photoCount === 1 ? 'y' : 'ies') + ' shining for you'
      : 'your account is ready; photos can be added by an administrator';
    nameInput.blur(); passwordInput.value = '';
    landing.style.opacity = '0'; landing.classList.remove('active','kb-open'); greeting.classList.add('show');
    setTimeout(()=>{ greeting.classList.remove('show'); starGroup.visible = true; flying = true; flightT = 0; galleryUI.classList.add('show'); }, prefersReducedMotion ? 900 : 2200);
  }catch(error){
    nameHint.textContent = error.message;
    passwordInput.value = ''; passwordInput.focus(); submit.disabled = false;
  }
});`;

let client = html.slice(0, start) + 'let memories = [];\n' + html.slice(end + 3);
client = client.replace(/\/\* ---------------------------------------------------------------------\n   STORAGE[\s\S]*?let captionCache = \{\};/, apiStorage);
client = client.replace(/const passwordInput =[\s\S]*?nameForm\.addEventListener\('submit',[\s\S]*?\n\}\);(?=\n\n\/\* ---------------------------------------------------------------------\n   MODAL)/, clientAuth + clientFlow);
client = client.replace(/captionCache = await loadCaptions\(\);\n  document.getElementById\('loading'\)/, "document.getElementById('loading')");
await writeFile(path.join(publicDir, 'index.html'), client);
console.log(`Prepared ${seededMemories.length} private memories and public/index.html.`);
