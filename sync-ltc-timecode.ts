#!/usr/bin/env -S npx tsx

import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import * as readline from "readline";

interface LTCFrame {
  userBits: string;
  timecode: string;
  position: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  frame: number;
  dropFrame: boolean;
}

interface AudioFileInfo {
  filename: string;
  timeReference?: string;
  creationTime?: string;
  duration?: string;
}

class LTCSyncTool {
  private sourceFile: string;
  private siblingFiles: string[] = [];
  private isDirectoryMode: boolean = false;

  constructor(sourceFile: string) {
    this.sourceFile = path.resolve(sourceFile);

    // Check if input is a directory
    if (fs.statSync(this.sourceFile).isDirectory()) {
      this.isDirectoryMode = true;
    } else {
      this.findSiblingFiles();
    }
  }

  private findSiblingFiles(): void {
    const dir = path.dirname(this.sourceFile);
    const baseName = path.basename(
      this.sourceFile,
      path.extname(this.sourceFile)
    );

    // Find files with similar base names (before the last part)
    const files = fs.readdirSync(dir).filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return ext === ".wav" && file !== path.basename(this.sourceFile);
    });

    // Filter for sibling files (same base name pattern)
    this.siblingFiles = files
      .map((file) => path.join(dir, file))
      .filter((file) => {
        const fileBaseName = path.basename(file, path.extname(file));
        // Check if it's a sibling (similar naming pattern)
        return this.isSiblingFile(baseName, fileBaseName);
      });

    console.log(
      `Found ${this.siblingFiles.length} sibling files:`,
      this.siblingFiles.map((f) => path.basename(f))
    );
  }

  private async discoverFilePatterns(): Promise<string[]> {
    const files = fs.readdirSync(this.sourceFile).filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return ext === ".wav";
    });

    // Extract patterns from filenames
    const patterns = new Set<string>();
    const patternFiles = new Map<string, string[]>();

    for (const file of files) {
      const baseName = path.basename(file, ".wav");
      const parts = baseName.split("_");

      if (parts.length >= 3) {
        // Get the last part as the pattern (e.g., "1-2", "3", "5-6", "MIX")
        const pattern = parts[parts.length - 1];
        patterns.add(pattern);

        if (!patternFiles.has(pattern)) {
          patternFiles.set(pattern, []);
        }
        patternFiles.get(pattern)!.push(file);
      }
    }

    // Convert to sorted array
    const sortedPatterns = Array.from(patterns).sort();

    console.log(
      `\n🔍 Found ${files.length} WAV files with the following patterns:`
    );
    console.log("");

    sortedPatterns.forEach((pattern, index) => {
      const fileCount = patternFiles.get(pattern)!.length;
      console.log(`  ${index + 1}. ${pattern} (${fileCount} files)`);
    });

    console.log("");

    // Prompt user to select pattern
    const selectedPattern = await this.promptForPattern(sortedPatterns);

    const sourceFiles = patternFiles
      .get(selectedPattern)!
      .map((file) => path.join(this.sourceFile, file));

    console.log(
      `\n✅ Selected pattern "${selectedPattern}" with ${sourceFiles.length} files:`,
      sourceFiles.map((f) => path.basename(f))
    );

    return sourceFiles;
  }

  private async promptForPattern(patterns: string[]): Promise<string> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve) => {
      const askQuestion = () => {
        rl.question(
          "Which pattern contains the timecode? Enter the number (1-" +
            patterns.length +
            "): ",
          (answer) => {
            const choice = parseInt(answer);

            if (choice >= 1 && choice <= patterns.length) {
              rl.close();
              resolve(patterns[choice - 1]);
            } else {
              console.log(
                `❌ Please enter a number between 1 and ${patterns.length}`
              );
              askQuestion();
            }
          }
        );
      };

      askQuestion();
    });
  }

  private isSiblingFile(sourceBase: string, targetBase: string): boolean {
    // For files like "250913_0009_1-2" and "250913_0009_3",
    // they should be considered siblings if they share the same prefix pattern

    // Split by underscore to get parts
    const sourceParts = sourceBase.split("_");
    const targetParts = targetBase.split("_");

    if (sourceParts.length < 3 || targetParts.length < 3) return false;

    // Check if they share the same first two parts (date and sequence)
    const sourcePrefix = sourceParts.slice(0, 2).join("_");
    const targetPrefix = targetParts.slice(0, 2).join("_");

    return sourcePrefix === targetPrefix;
  }

  private runLTCdump(): LTCFrame[] {
    console.log(
      `\n🔍 Extracting LTC timecode from: ${path.basename(this.sourceFile)}`
    );

    try {
      const output = execSync(`ltcdump "${this.sourceFile}" -vv`, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 50, // 10MB buffer
      });

      const lines = output
        .split("\n")
        .filter(
          (line) =>
            line.trim() &&
            !line.startsWith("#") &&
            !line.includes("DISCONTINUITY")
        );

      if (lines.length === 0) {
        throw new Error("No LTC frames found in the source file");
      }

      const frames: LTCFrame[] = [];

      for (const line of lines) {
        const frame = this.parseLTCFrame(line);
        if (frame) {
          frames.push(frame);
        }
      }

      console.log(`✅ Found ${frames.length} LTC frames`);
      return frames;
    } catch (error) {
      console.error(`❌ Error running ltcdump: ${error}`);
      throw error;
    }
  }

  private parseLTCFrame(line: string): LTCFrame | null {
    try {
      // Format: "ce410081   30:04:00.16 |  2660708  2662667 R"
      const parts = line.trim().split("|");
      if (parts.length !== 2) return null;

      const leftPart = parts[0].trim();
      const rightPart = parts[1].trim();

      // Parse left part: user bits and timecode
      const leftParts = leftPart.split(/\s+/);
      const userBits = leftParts[0];
      const timecode = leftParts.slice(1).join(" ");

      // Parse user bits (YYMMDDXX format for date)
      if (userBits.length !== 8) return null;

      // Parse user bits as date in YYMMDDXX format
      let year = parseInt("20" + userBits.substring(0, 2));
      let month = parseInt(userBits.substring(2, 4));
      let day = parseInt(userBits.substring(4, 6));

      // Validate the parsed date
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        console.warn(
          `⚠️  Invalid date in user bits ${userBits}, using current date`
        );
        const now = new Date();
        year = now.getFullYear();
        month = now.getMonth() + 1;
        day = now.getDate();
      }

      // Parse timecode (HH:MM:SS.FF or HH:MM:SS:FF)
      const timecodeMatch = timecode.match(
        /(\d{2}):(\d{2}):(\d{2})[.:](\d{2})/
      );
      if (!timecodeMatch) return null;

      let hour = parseInt(timecodeMatch[1]);
      const minute = parseInt(timecodeMatch[2]);
      const second = parseInt(timecodeMatch[3]);
      const frame = parseInt(timecodeMatch[4]);
      const dropFrame = timecode.includes(".");

      // Validate and correct invalid timecode values
      if (hour >= 24) {
        console.warn(
          `⚠️  Invalid hour ${hour} in timecode, correcting to ${hour % 24}`
        );
        hour = hour % 24;
      }

      if (minute >= 60) {
        console.warn(
          `⚠️  Invalid minute ${minute} in timecode, correcting to ${
            minute % 60
          }`
        );
      }

      if (second >= 60) {
        console.warn(
          `⚠️  Invalid second ${second} in timecode, correcting to ${
            second % 60
          }`
        );
      }

      return {
        userBits,
        timecode,
        position: rightPart.split(/\s+/)[0] || "0",
        year,
        month,
        day,
        hour,
        minute,
        second,
        frame,
        dropFrame,
      };
    } catch (error) {
      console.warn(`⚠️  Failed to parse LTC frame: ${line}`);
      return null;
    }
  }

  private getFirstValidFrame(frames: LTCFrame[]): LTCFrame {
    if (frames.length === 0) {
      throw new Error("No valid LTC frames found");
    }

    // Use the first frame as reference
    const frame = frames[0];
    console.log(
      `📅 Using reference frame: ${frame.timecode} (${frame.year}-${frame.month
        .toString()
        .padStart(2, "0")}-${frame.day.toString().padStart(2, "0")})`
    );
    return frame;
  }

  private calculateTimeReference(frame: LTCFrame): number {
    // Convert timecode to samples at 48kHz
    const frameRate = frame.dropFrame ? 29.97 : 30;
    const totalFrames =
      (frame.hour * 3600 + frame.minute * 60 + frame.second) * frameRate +
      frame.frame;
    const samples = Math.round((totalFrames * 48000) / frameRate);

    console.log(
      `🎯 Calculated time reference: ${samples} samples (${frameRate}fps)`
    );
    return samples;
  }

  private formatCreationTime(frame: LTCFrame): string {
    // Format as HH:MM:SS (8 characters max for OriginationTime)
    const timeString = `${frame.hour.toString().padStart(2, "0")}:${frame.minute
      .toString()
      .padStart(2, "0")}:${frame.second.toString().padStart(2, "0")}`;
    console.log(`🕐 Formatted creation time: ${timeString}`);
    return timeString;
  }

  private updateFileMetadata(
    filePath: string,
    timeReference: number,
    creationTime: string,
    frame: LTCFrame
  ): void {
    console.log(`\n📝 Updating metadata for: ${path.basename(filePath)}`);

    try {
      // Format date as YYYY-MM-DD for OriginationDate
      const originationDate = `${frame.year}-${frame.month
        .toString()
        .padStart(2, "0")}-${frame.day.toString().padStart(2, "0")}`;

      // Use bwfmetaedit to update the metadata
      const commands = [
        `--Timereference=${timeReference}`,
        `--OriginationTime="${creationTime}"`,
        `--OriginationDate="${originationDate}"`,
      ];

      const command = `bwfmetaedit ${commands.join(" ")} "${filePath}"`;
      console.log(`Running: ${command}`);

      execSync(command, { stdio: "pipe" });
      console.log(`✅ Successfully updated metadata`);
    } catch (error) {
      console.error(
        `❌ Error updating metadata for ${path.basename(filePath)}: ${error}`
      );
      throw error;
    }
  }

  private verifyFileMetadata(filePath: string): AudioFileInfo {
    console.log(`\n🔍 Verifying metadata for: ${path.basename(filePath)}`);

    try {
      const output = execSync(`ffprobe -v quiet -show_format "${filePath}"`, {
        encoding: "utf8",
      });

      const info: AudioFileInfo = { filename: path.basename(filePath) };

      // Parse ffprobe output
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.startsWith("TAG:time_reference=")) {
          info.timeReference = line.split("=")[1];
        } else if (line.startsWith("TAG:creation_time=")) {
          info.creationTime = line.split("=")[1];
        } else if (line.startsWith("duration=")) {
          info.duration = line.split("=")[1];
        }
      }

      console.log(`📊 Current metadata:`);
      console.log(`   Time Reference: ${info.timeReference || "Not set"}`);
      console.log(`   Creation Time: ${info.creationTime || "Not set"}`);
      console.log(`   Duration: ${info.duration || "Unknown"}`);

      return info;
    } catch (error) {
      console.error(`❌ Error verifying metadata: ${error}`);
      throw error;
    }
  }

  private async processSingleSourceFile(sourceFile: string): Promise<void> {
    console.log(`\n🔍 Processing source file: ${path.basename(sourceFile)}`);

    // Create a temporary instance for this source file
    const tempTool = new LTCSyncTool(sourceFile);

    if (tempTool.siblingFiles.length === 0) {
      console.log("⚠️  No sibling files found to update");
      return;
    }

    try {
      // Extract LTC data from source file
      const frames = tempTool.runLTCdump();
      const referenceFrame = tempTool.getFirstValidFrame(frames);

      // Calculate metadata values
      const timeReference = tempTool.calculateTimeReference(referenceFrame);
      const creationTime = tempTool.formatCreationTime(referenceFrame);

      // Update each sibling file
      for (const filePath of tempTool.siblingFiles) {
        try {
          // Show current metadata
          tempTool.verifyFileMetadata(filePath);

          // Update metadata
          tempTool.updateFileMetadata(
            filePath,
            timeReference,
            creationTime,
            referenceFrame
          );

          // Verify the update
          tempTool.verifyFileMetadata(filePath);
        } catch (error) {
          console.error(
            `❌ Failed to process ${path.basename(filePath)}: ${error}`
          );
          // Continue with other files
        }
      }

      console.log(`✅ Completed processing ${path.basename(sourceFile)}`);
      console.log(`📊 Updated ${tempTool.siblingFiles.length} files with:`);
      console.log(`   Time Reference: ${timeReference}`);
      console.log(`   Creation Time: ${creationTime}`);
    } catch (error) {
      console.error(
        `❌ Failed to process ${path.basename(sourceFile)}: ${error}`
      );
      // Continue with other files
    }
  }

  public async syncTimecode(): Promise<void> {
    console.log(`🚀 Starting LTC timecode synchronization`);

    if (this.isDirectoryMode) {
      console.log(`📁 Directory mode: ${this.sourceFile}`);

      const sourceFiles = await this.discoverFilePatterns();

      if (sourceFiles.length === 0) {
        console.log("⚠️  No files found with the selected pattern");
        return;
      }

      // Process each source file
      for (const sourceFile of sourceFiles) {
        await this.processSingleSourceFile(sourceFile);
      }

      console.log(`\n🎉 LTC timecode synchronization completed!`);
      console.log(`📊 Processed ${sourceFiles.length} source files`);
    } else {
      console.log(`📁 Source file: ${this.sourceFile}`);
      console.log(`📁 Sibling files: ${this.siblingFiles.length}`);

      if (this.siblingFiles.length === 0) {
        console.log("⚠️  No sibling files found to update");
        return;
      }

      try {
        // Extract LTC data from source file
        const frames = this.runLTCdump();
        const referenceFrame = this.getFirstValidFrame(frames);

        // Calculate metadata values
        const timeReference = this.calculateTimeReference(referenceFrame);
        const creationTime = this.formatCreationTime(referenceFrame);

        // Update each sibling file
        for (const filePath of this.siblingFiles) {
          try {
            // Show current metadata
            this.verifyFileMetadata(filePath);

            // Update metadata
            this.updateFileMetadata(
              filePath,
              timeReference,
              creationTime,
              referenceFrame
            );

            // Verify the update
            this.verifyFileMetadata(filePath);
          } catch (error) {
            console.error(
              `❌ Failed to process ${path.basename(filePath)}: ${error}`
            );
            // Continue with other files
          }
        }

        console.log(`\n🎉 LTC timecode synchronization completed!`);
        console.log(`📊 Updated ${this.siblingFiles.length} files with:`);
        console.log(`   Time Reference: ${timeReference}`);
        console.log(`   Creation Time: ${creationTime}`);
      } catch (error) {
        console.error(`❌ Synchronization failed: ${error}`);
        process.exit(1);
      }
    }
  }
}

// Project directory discovery
async function discoverProjectDirectories(): Promise<string[]> {
  const currentDir = process.cwd();
  const parentDir = path.dirname(currentDir);

  try {
    const projectDirs: string[] = [];

    // Find direct project directories in parent dir
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    const directProjects = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        // Only show date-based project directories
        return name.match(/^\d{4}-\d{2}-\d{2}-/);
      })
      .map((name) => path.join(parentDir, name));

    projectDirs.push(...directProjects);

    // Find projects under _Others/<artist-name>/<project-directory>
    const othersDir = path.join(parentDir, "_Others");
    if (fs.existsSync(othersDir)) {
      const artistDirs = fs.readdirSync(othersDir, { withFileTypes: true });

      for (const artistDir of artistDirs) {
        if (artistDir.isDirectory()) {
          const artistPath = path.join(othersDir, artistDir.name);
          const artistProjects = fs
            .readdirSync(artistPath, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .filter((entry) => entry.name.match(/^\d{4}-\d{2}-\d{2}-/))
            .map((entry) => path.join(artistPath, entry.name));

          projectDirs.push(...artistProjects);
        }
      }
    }

    // Sort all projects in reverse chronological order (most recent first)
    projectDirs.sort((a, b) => {
      const aName = path.basename(a);
      const bName = path.basename(b);
      return bName.localeCompare(aName);
    });

    return projectDirs;
  } catch (error) {
    console.error(`❌ Error reading parent directory: ${error}`);
    return [];
  }
}

async function promptForProjectDirectory(): Promise<string | null> {
  console.log("🔍 Discovering project directories...");

  const projectDirs = await discoverProjectDirectories();

  if (projectDirs.length === 0) {
    console.log("❌ No project directories found in parent directory");
    return null;
  }

  console.log(`\n📁 Found ${projectDirs.length} project directories:`);
  console.log("");

  const parentDir = path.dirname(process.cwd());
  projectDirs.forEach((dir, index) => {
    const dirName = path.basename(dir);
    const parentName = path.basename(path.dirname(dir));

    // Check if this project is under _Others/<artist-name>/
    if (path.dirname(path.dirname(dir)) === path.join(parentDir, "_Others")) {
      console.log(`  ${index + 1}. ${dirName} (${parentName})`);
    } else {
      console.log(`  ${index + 1}. ${dirName}`);
    }
  });

  console.log("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const askQuestion = () => {
      rl.question(
        "Which project directory? Enter the number (1-" +
          projectDirs.length +
          "): ",
        (answer) => {
          const choice = parseInt(answer);

          if (choice >= 1 && choice <= projectDirs.length) {
            rl.close();
            resolve(projectDirs[choice - 1]);
          } else {
            console.log(
              `❌ Please enter a number between 1 and ${projectDirs.length}`
            );
            askQuestion();
          }
        }
      );
    };

    askQuestion();
  });
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // No arguments provided - prompt for project directory
    console.log("🚀 LTC Timecode Synchronization Tool");
    console.log("");

    const projectDir = await promptForProjectDirectory();
    if (!projectDir) {
      console.log("❌ No project selected. Exiting.");
      process.exit(1);
    }

    // Check if Audio subdirectory exists
    const audioDir = path.join(projectDir, "Audio");
    if (!fs.existsSync(audioDir)) {
      console.log(
        `❌ Audio directory not found in ${path.basename(projectDir)}`
      );
      console.log("Expected directory structure: <project>/Audio/");
      process.exit(1);
    }

    console.log(`✅ Selected project: ${path.basename(projectDir)}`);
    console.log(`📁 Using Audio directory: ${audioDir}`);
    console.log("");

    // Use the Audio directory as the target
    args[0] = audioDir;
  }

  const sourceFile = args[0];

  if (!fs.existsSync(sourceFile)) {
    console.error(`❌ Source file or directory not found: ${sourceFile}`);
    process.exit(1);
  }

  const stat = fs.statSync(sourceFile);
  if (stat.isFile()) {
    const ext = path.extname(sourceFile).toLowerCase();
    if (ext !== ".wav") {
      console.error(`❌ Source file must be a WAV file: ${sourceFile}`);
      process.exit(1);
    }
  }

  const syncTool = new LTCSyncTool(sourceFile);
  syncTool.syncTimecode().catch((error) => {
    console.error(`❌ Fatal error: ${error}`);
    process.exit(1);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ Fatal error: ${error}`);
    process.exit(1);
  });
}

export { LTCSyncTool };
