# LTC Timecode Synchronization Tool

This TypeScript script synchronizes timecode metadata across sibling WAV files using LTC (Linear Time Code) data extracted from a source file.

## Features

- 🔍 Extracts LTC timecode from WAV files using `ltcdump`
- 📁 Automatically finds sibling files in the same directory
- ⏰ Updates `time_reference` and `creation_time` metadata using `bwfmetaedit`
- ✅ Verifies changes using `ffprobe`
- 🛠️ Handles corrupted LTC data with validation and correction

## Prerequisites

Install the required tools:

```bash
# Install ltcdump (if not already installed)
brew install libltc

# Install bwfmetaedit
brew install bwfmetaedit

# Install ffprobe (part of ffmpeg)
brew install ffmpeg
```

## Usage

```bash
# Run the script
npx tsx sync-ltc-timecode.ts <source-wav-file>

# Or use the npm script
npm run sync-ltc <source-wav-file>

# Example
npx tsx sync-ltc-timecode.ts example/Audio/250913_0009_MIX.wav
```

## How it works

1. **LTC Extraction**: Uses `ltcdump` to extract LTC timecode data from the source WAV file
2. **Sibling Detection**: Finds other WAV files in the same directory that share the same naming pattern
3. **Metadata Calculation**: Calculates `time_reference` (in samples) and `creation_time` from the LTC data
4. **Metadata Update**: Uses `bwfmetaedit` to update the metadata in all sibling files
5. **Verification**: Uses `ffprobe` to verify the changes were applied correctly

## File Naming Convention

The script identifies sibling files by their naming pattern. For example:

- `250913_0009_1-2.wav`
- `250913_0009_3.wav`
- `250913_0009_5-6.wav`
- `250913_0009_MIX.wav`

All these files share the same prefix `250913_0009_` and are considered siblings.

## Output

The script provides detailed logging showing:

- LTC frame extraction results
- Sibling files found
- Metadata calculations
- Update operations
- Verification results

## Error Handling

- Validates and corrects invalid timecode values (e.g., hour > 23)
- Continues processing other files if one fails
- Provides clear error messages for troubleshooting

## Example Output

```
🚀 Starting LTC timecode synchronization
📁 Source file: /path/to/source.wav
📁 Sibling files: 3

🔍 Extracting LTC timecode from: source.wav
✅ Found 93 LTC frames
📅 Using reference frame: 06:04:00.16 (2025-09-15)
🎯 Calculated time reference: 1048345626 samples (29.97fps)
🕐 Formatted creation time: 06:04:00

📝 Updating metadata for: sibling1.wav
✅ Successfully updated metadata

🎉 LTC timecode synchronization completed!
📊 Updated 3 files with:
   Time Reference: 1048345626
   Creation Time: 06:04:00
```
