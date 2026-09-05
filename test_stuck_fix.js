const fs = require('fs');
const path = require('path');

const encoderCode = fs.readFileSync(path.join(__dirname, 'web/encoder/encoder.js'), 'utf8');

global.window = global;
global.document = {
  getElementById: () => ({ textContent: '', disabled: false })
};
global.CustomEvent = class {};
global.dispatchEvent = () => {};
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;

eval(encoderCode);

function stripLeadingPreambleBits(bits) {
  let startIndex = 0;
  const maxSearch = Math.min(60, bits.length - 15);
  for (let i = 1; i < maxSearch; i++) {
    if (bits[i] === bits[i - 1]) {
      startIndex = (bits[i] === 0) ? i : Math.max(0, i - 1);
      break;
    }
  }
  return startIndex;
}

console.log('--- TESTING STRIP LEADING PREAMBLE BITS ---');

const testBits1 = [0,1,0,1,0,1,0,1,0,1,0,1,0,0,0,0,1,0,1,1,1, 0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1];
const idx1 = stripLeadingPreambleBits(testBits1);
console.log(`Test 1: idx = ${idx1} (Expected ~12-13), Slice starts with:`, testBits1.slice(idx1, idx1 + 5));

const testBits2 = [0,1,0,1,0,1,0,1,1,0,0,0,1,0,1,1, 0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1];
const idx2 = stripLeadingPreambleBits(testBits2);
console.log(`Test 2: idx = ${idx2} (Expected ~7-8), Slice starts with:`, testBits2.slice(idx2, idx2 + 5));
