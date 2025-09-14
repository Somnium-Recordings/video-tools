import path from "path";
import fs from "fs";

const file = path.join(__dirname, "test-tc-1.wav");
const buffer = fs.readFileSync(file);

// Parse WAV header
function parseWavHeader(buffer: Buffer) {
  let offset = 0;
  let sampleRate = 48000;
  let bitsPerSample = 16;
  let numChannels = 1;

  // RIFF header
  const riffHeader = buffer.toString("ascii", offset, offset + 4);
  offset += 4;
  const fileSize = buffer.readUInt32LE(offset);
  offset += 4;
  const waveHeader = buffer.toString("ascii", offset, offset + 4);
  offset += 4;

  console.log(`RIFF: ${riffHeader}, Size: ${fileSize}, WAVE: ${waveHeader}`);

  // Find fmt chunk
  while (offset < buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    offset += 4;
    const chunkSize = buffer.readUInt32LE(offset);
    offset += 4;

    if (chunkId === "fmt ") {
      const audioFormat = buffer.readUInt16LE(offset);
      numChannels = buffer.readUInt16LE(offset + 2);
      sampleRate = buffer.readUInt32LE(offset + 4);
      const byteRate = buffer.readUInt32LE(offset + 8);
      const blockAlign = buffer.readUInt16LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 14);

      console.log(
        `Format: ${audioFormat}, Channels: ${numChannels}, Sample Rate: ${sampleRate}, Bits: ${bitsPerSample}`
      );

      offset += chunkSize;
    } else if (chunkId === "data") {
      console.log(`Data chunk found at offset ${offset}, size: ${chunkSize}`);
      return {
        dataOffset: offset,
        dataSize: chunkSize,
        sampleRate,
        bitsPerSample,
        numChannels,
      };
    } else {
      offset += chunkSize;
    }
  }

  throw new Error("Data chunk not found");
}

const wavInfo = parseWavHeader(buffer);

// LTC Frame structure (80 bits total)
interface LTCFrame {
  frame: number;
  second: number;
  minute: number;
  hour: number;
  dropFrame: boolean;
  colorFrame: boolean;
  binaryGroup1: number;
  binaryGroup2: number;
  binaryGroup3: number;
  binaryGroup4: number;
  binaryGroup5: number;
  binaryGroup6: number;
  binaryGroup7: number;
  binaryGroup8: number;
}

// Convert audio samples to digital signal (threshold detection)
function audioToDigital(
  buffer: Buffer,
  dataOffset: number,
  sampleRate: number,
  bitsPerSample: number,
  maxSamples: number = 48000 * 10
): boolean[] {
  const bytesPerSample = bitsPerSample / 8;
  const availableSamples = Math.floor(
    (buffer.length - dataOffset) / bytesPerSample
  );
  const numSamples = Math.min(availableSamples, maxSamples);
  const digital: boolean[] = [];

  console.log(
    `Processing ${numSamples} samples from ${availableSamples} available`
  );

  // Simple threshold detection for LTC signal
  const threshold = 0;

  for (let i = 0; i < numSamples; i++) {
    const sampleOffset = dataOffset + i * bytesPerSample;
    let sample: number;

    if (bitsPerSample === 32) {
      // 32-bit float
      sample = buffer.readFloatLE(sampleOffset);
    } else if (bitsPerSample === 16) {
      sample = buffer.readInt16LE(sampleOffset);
    } else {
      sample = buffer.readInt8(sampleOffset);
    }

    digital.push(sample > threshold);
  }

  return digital;
}

// State-change based Manchester decoding (based on libltc approach)
function detectManchesterBits(
  digital: boolean[],
  sampleRate: number
): number[] {
  const bitsPerSecond = 2400;
  const expectedSamplesPerBit = sampleRate / bitsPerSecond;

  console.log(`Expected samples per bit: ${expectedSamplesPerBit}`);

  let currentState = digital[0] ? 1 : 0;
  let samplesPerBit = expectedSamplesPerBit;
  let samplesSinceChange = 0;
  let bits: number[] = [];
  let pendingBit = false;

  // Collect a good amount of bits first
  for (let i = 1; i < digital.length && bits.length < 1000; i++) {
    const newState = digital[i] ? 1 : 0;
    samplesSinceChange++;

    if (newState !== currentState) {
      const halfBitPeriod = samplesPerBit * 0.5;
      const fullBitPeriod = samplesPerBit;

      if (samplesSinceChange < halfBitPeriod * 1.5) {
        if (pendingBit) {
          bits.push(1);
          pendingBit = false;
        } else {
          pendingBit = true;
        }
      } else if (samplesSinceChange < fullBitPeriod * 1.5) {
        if (pendingBit) {
          bits.push(1);
        }
        bits.push(0);
        pendingBit = false;
        samplesPerBit = samplesPerBit * 0.99 + samplesSinceChange * 0.01;
      } else {
        if (pendingBit) {
          bits.push(1);
          pendingBit = false;
        }
      }

      currentState = newState;
      samplesSinceChange = 0;
    }
  }

  if (pendingBit) {
    bits.push(1);
  }

  console.log(
    `Extracted ${bits.length} total bits using state-change detection`
  );

  // Now search for sync pattern in the bit stream
  const syncPattern = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]; // 0x3FFD

  for (let i = 0; i <= bits.length - 80; i++) {
    // Check if sync pattern matches at position i + 64 (last 16 bits of 80-bit frame)
    if (i + 80 <= bits.length) {
      const frameCandidate = bits.slice(i, i + 80);
      const candidateSync = frameCandidate.slice(64, 80);

      // Count matching bits
      const matches = candidateSync.filter(
        (bit, idx) => bit === syncPattern[idx]
      ).length;

      if (matches >= 15) {
        // Allow 1 bit error
        console.log(
          `Found LTC frame at bit position ${i}, sync matches: ${matches}/16`
        );
        console.log(`Sync pattern: ${candidateSync.join("")}`);

        let syncHex = 0;
        for (let j = 0; j < 16; j++) {
          syncHex = (syncHex << 1) | candidateSync[j];
        }
        console.log(`Sync word: 0x${syncHex.toString(16).toUpperCase()}`);

        return frameCandidate;
      }
    }
  }

  console.log("No valid LTC frame found with proper sync");
  return [];
}

// State-change based Manchester decoding starting from exact position
function detectManchesterBitsFromPosition(
  digital: boolean[],
  sampleRate: number
): number[] {
  const bitsPerSecond = 2400;
  const expectedSamplesPerBit = sampleRate / bitsPerSecond;

  console.log(`Expected samples per bit: ${expectedSamplesPerBit}`);
  console.log(`Digital signal length from start position: ${digital.length}`);

  let currentState = digital[0] ? 1 : 0;
  let samplesPerBit = expectedSamplesPerBit;
  let samplesSinceChange = 0;
  let bits: number[] = [];
  let pendingBit = false;

  // Process until we have exactly 80 bits (one complete LTC frame)
  for (let i = 1; i < digital.length && bits.length < 80; i++) {
    const newState = digital[i] ? 1 : 0;
    samplesSinceChange++;

    if (newState !== currentState) {
      const halfBitPeriod = samplesPerBit * 0.5;
      const fullBitPeriod = samplesPerBit;

      if (samplesSinceChange < halfBitPeriod * 1.5) {
        // Short period - half bit
        if (pendingBit) {
          bits.push(1);
          pendingBit = false;
        } else {
          pendingBit = true;
        }
      } else if (samplesSinceChange < fullBitPeriod * 1.5) {
        // Full bit period - zero bit
        if (pendingBit) {
          bits.push(1);
        }
        bits.push(0);
        pendingBit = false;
        // Adaptive timing
        samplesPerBit = samplesPerBit * 0.95 + samplesSinceChange * 0.05;
      } else {
        // Long period
        if (pendingBit) {
          bits.push(1);
          pendingBit = false;
        }
      }

      currentState = newState;
      samplesSinceChange = 0;
    }
  }

  if (pendingBit && bits.length < 80) {
    bits.push(1);
  }

  console.log(`Extracted ${bits.length} bits from exact position`);
  if (bits.length >= 64) {
    const syncBits = bits.slice(Math.max(0, bits.length - 16));
    console.log(`Last 16 bits (sync): ${syncBits.join("")}`);

    let syncHex = 0;
    for (let i = 0; i < syncBits.length; i++) {
      syncHex = (syncHex << 1) | syncBits[i];
    }
    console.log(`Sync word: 0x${syncHex.toString(16).toUpperCase()}`);
  }

  // Debug: show the complete 80-bit pattern
  console.log(`Complete 80-bit frame: ${bits.slice(0, 80).join("")}`);

  return bits.slice(0, 80);
}

// Parse LTC frame from 80-bit sequence
function parseLTCFrame(
  bits: number[],
  debug: boolean = false
): LTCFrame | null {
  if (bits.length < 80) return null;

  // Extract bits according to LTC standard (BCD format, LSB first)
  const frame_units =
    (bits[3] << 3) | (bits[2] << 2) | (bits[1] << 1) | bits[0];
  const frame_tens = (bits[9] << 1) | bits[8];

  const second_units =
    (bits[19] << 3) | (bits[18] << 2) | (bits[17] << 1) | bits[16];
  const second_tens = (bits[26] << 2) | (bits[25] << 1) | bits[24];

  const minute_units =
    (bits[35] << 3) | (bits[34] << 2) | (bits[33] << 1) | bits[32];
  const minute_tens = (bits[42] << 2) | (bits[41] << 1) | bits[40];

  const hour_units =
    (bits[51] << 3) | (bits[50] << 2) | (bits[49] << 1) | bits[48];
  const hour_tens = (bits[57] << 1) | bits[56];

  // Check sync word (bits 64-79 should be 0011111111111101)
  const syncWord = bits.slice(64, 80);
  const expectedSync = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
  const syncMatches = syncWord.filter(
    (bit, i) => bit === expectedSync[i]
  ).length;

  if (syncMatches < 14) {
    // Allow up to 2 bit errors in sync
    if (debug)
      console.log(
        `Sync word mismatch: ${syncWord.join("")}, matches: ${syncMatches}/16`
      );
    return null;
  }

  // User bits (also LSB first)
  const binaryGroup1 =
    (bits[7] << 3) | (bits[6] << 2) | (bits[5] << 1) | bits[4];
  const binaryGroup2 =
    (bits[15] << 3) | (bits[14] << 2) | (bits[13] << 1) | bits[12];
  const binaryGroup3 =
    (bits[23] << 3) | (bits[22] << 2) | (bits[21] << 1) | bits[20];
  const binaryGroup4 =
    (bits[31] << 3) | (bits[30] << 2) | (bits[29] << 1) | bits[28];
  const binaryGroup5 =
    (bits[39] << 3) | (bits[38] << 2) | (bits[37] << 1) | bits[36];
  const binaryGroup6 =
    (bits[47] << 3) | (bits[46] << 2) | (bits[45] << 1) | bits[44];
  const binaryGroup7 =
    (bits[55] << 3) | (bits[54] << 2) | (bits[53] << 1) | bits[52];
  const binaryGroup8 =
    (bits[63] << 3) | (bits[62] << 2) | (bits[61] << 1) | bits[60];

  if (debug) {
    console.log("Decoded values:");
    console.log(
      `  Frame units (bits 0-3): ${bits[3]}${bits[2]}${bits[1]}${bits[0]} = ${frame_units}`
    );
    console.log(
      `  Frame tens (bits 8-9): ${bits[9]}${bits[8]} = ${frame_tens}`
    );
    console.log(
      `  Second units (bits 16-19): ${bits[19]}${bits[18]}${bits[17]}${bits[16]} = ${second_units}`
    );
    console.log(
      `  Second tens (bits 24-26): ${bits[26]}${bits[25]}${bits[24]} = ${second_tens}`
    );
    console.log(
      `  Minute units (bits 32-35): ${bits[35]}${bits[34]}${bits[33]}${bits[32]} = ${minute_units}`
    );
    console.log(
      `  Minute tens (bits 40-42): ${bits[42]}${bits[41]}${bits[40]} = ${minute_tens}`
    );
    console.log(
      `  Hour units (bits 48-51): ${bits[51]}${bits[50]}${bits[49]}${bits[48]} = ${hour_units}`
    );
    console.log(
      `  Hour tens (bits 56-57): ${bits[57]}${bits[56]} = ${hour_tens}`
    );

    console.log(
      `Sync word found with ${syncMatches}/16 matches: ${syncWord.join("")}`
    );

    console.log("User bits:");
    console.log(
      `  Group 1 (bits 4-7): ${bits[7]}${bits[6]}${bits[5]}${bits[4]} = ${binaryGroup1}`
    );
    console.log(
      `  Group 2 (bits 12-15): ${bits[15]}${bits[14]}${bits[13]}${bits[12]} = ${binaryGroup2}`
    );
    console.log(
      `  Group 3 (bits 20-23): ${bits[23]}${bits[22]}${bits[21]}${bits[20]} = ${binaryGroup3}`
    );
    console.log(
      `  Group 4 (bits 28-31): ${bits[31]}${bits[30]}${bits[29]}${bits[28]} = ${binaryGroup4}`
    );
    console.log(
      `  Group 5 (bits 36-39): ${bits[39]}${bits[38]}${bits[37]}${bits[36]} = ${binaryGroup5}`
    );
    console.log(
      `  Group 6 (bits 44-47): ${bits[47]}${bits[46]}${bits[45]}${bits[44]} = ${binaryGroup6}`
    );
    console.log(
      `  Group 7 (bits 52-55): ${bits[55]}${bits[54]}${bits[53]}${bits[52]} = ${binaryGroup7}`
    );
    console.log(
      `  Group 8 (bits 60-63): ${bits[63]}${bits[62]}${bits[61]}${bits[60]} = ${binaryGroup8}`
    );

    const userBitsString = `${binaryGroup8}${binaryGroup7}${binaryGroup6}${binaryGroup5}${binaryGroup4}${binaryGroup3}${binaryGroup2}${binaryGroup1}`;
    console.log(`User bits as 8-digit string: ${userBitsString}`);
  }

  return {
    frame: frame_tens * 10 + frame_units,
    second: second_tens * 10 + second_units,
    minute: minute_tens * 10 + minute_units,
    hour: hour_tens * 10 + hour_units,
    dropFrame: bits[10] === 1,
    colorFrame: bits[11] === 1,
    binaryGroup1,
    binaryGroup2,
    binaryGroup3,
    binaryGroup4,
    binaryGroup5,
    binaryGroup6,
    binaryGroup7,
    binaryGroup8,
  };
}

// Auto-detect first valid LTC frame position
function findFirstValidLTCFrame(
  digital: boolean[],
  sampleRate: number
): { frame: LTCFrame; samplePosition: number } | null {
  const bitsPerSecond = 2400;
  const expectedSamplesPerBit = sampleRate / bitsPerSecond;
  const frameSamples = Math.round(expectedSamplesPerBit * 80);

  console.log("Scanning for first valid LTC frame...");

  // Search in chunks to find the first valid frame
  const chunkSize = frameSamples * 4; // Search in 4-frame chunks

  for (
    let startPos = 0;
    startPos < digital.length - chunkSize;
    startPos += Math.round(expectedSamplesPerBit * 10)
  ) {
    const chunk = digital.slice(startPos, startPos + chunkSize);

    try {
      const bits = detectManchesterBits(chunk, sampleRate);

      if (bits.length >= 80) {
        const frame = parseLTCFrame(bits);
        if (frame) {
          console.log(
            `Found valid LTC frame at approximate sample position ${startPos}`
          );
          return { frame, samplePosition: startPos };
        }
      }
    } catch (error) {
      // Continue searching if this chunk fails
      continue;
    }
  }

  return null;
}

// Main parsing function
function parseFirstLTCFrame(): {
  frame: LTCFrame;
  samplePosition: number;
} | null {
  console.log("Converting audio to digital signal...");
  const digital = audioToDigital(
    buffer,
    wavInfo.dataOffset,
    wavInfo.sampleRate,
    wavInfo.bitsPerSample
  );

  console.log("Auto-detecting first valid LTC frame...");
  return findFirstValidLTCFrame(digital, wavInfo.sampleRate);
}

const firstFrame = parseFirstLTCFrame();

// Output results in human readable form
function displayLTCFrame(
  result: { frame: LTCFrame; samplePosition: number } | null
) {
  if (!result) {
    console.log("No valid LTC frame found");
    return;
  }

  const { frame, samplePosition } = result;

  console.log("\n=== LTC Frame Information ===");
  console.log(
    `Sample Position: ${samplePosition} (${(
      samplePosition / wavInfo.sampleRate
    ).toFixed(3)}s into file)`
  );
  console.log(
    `Timecode: ${frame.hour.toString().padStart(2, "0")}:${frame.minute
      .toString()
      .padStart(2, "0")}:${frame.second
      .toString()
      .padStart(2, "0")}:${frame.frame.toString().padStart(2, "0")}`
  );
  console.log(`Drop Frame: ${frame.dropFrame ? "Yes" : "No"}`);
  console.log(`Color Frame: ${frame.colorFrame ? "Yes" : "No"}`);
  console.log(`Binary Groups:`);
  console.log(`  Group 1: 0x${frame.binaryGroup1.toString(16).toUpperCase()}`);
  console.log(`  Group 2: 0x${frame.binaryGroup2.toString(16).toUpperCase()}`);
  console.log(`  Group 3: 0x${frame.binaryGroup3.toString(16).toUpperCase()}`);
  console.log(`  Group 4: 0x${frame.binaryGroup4.toString(16).toUpperCase()}`);
  console.log(`  Group 5: 0x${frame.binaryGroup5.toString(16).toUpperCase()}`);
  console.log(`  Group 6: 0x${frame.binaryGroup6.toString(16).toUpperCase()}`);
  console.log(`  Group 7: 0x${frame.binaryGroup7.toString(16).toUpperCase()}`);
  console.log(`  Group 8: 0x${frame.binaryGroup8.toString(16).toUpperCase()}`);

  // Show user bits as ltcdump format and parse as date
  const userBitsString = `${frame.binaryGroup8}${frame.binaryGroup7}${frame.binaryGroup6}${frame.binaryGroup5}${frame.binaryGroup4}${frame.binaryGroup3}${frame.binaryGroup2}${frame.binaryGroup1}`;
  console.log(`User Bits: ${userBitsString}`);

  // Parse user bits as date (YYMMDDXX format)
  if (userBitsString.length === 8) {
    const year = parseInt(userBitsString.substring(0, 2));
    const month = parseInt(userBitsString.substring(2, 4));
    const day = parseInt(userBitsString.substring(4, 6));
    const extra = userBitsString.substring(6, 8);

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const fullYear = year < 50 ? 2000 + year : 1900 + year; // Assume 00-49 = 20xx, 50-99 = 19xx
      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];

      console.log(
        `Date: ${monthNames[month - 1]} ${day}, ${fullYear}${
          extra !== "00" ? ` (extra: ${extra})` : ""
        }`
      );
    }
  }

  // Additional frame rate information
  if (frame.dropFrame) {
    console.log("Frame Rate: 29.97 fps (Drop Frame)");
  } else {
    // Need to infer frame rate from context or additional analysis
    console.log("Frame Rate: Likely 30fps, 25fps, or 24fps (Non-Drop Frame)");
  }
}

displayLTCFrame(firstFrame);
