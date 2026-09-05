import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ImageProcessorService } from './image-processor.service';

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('ImageProcessorService RGB sources', () => {
  it('retains distinct source colors when preparing a published screen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'inker-color-source-'));
    const input = join(directory, 'input.png');
    const output = join(directory, 'output.png');
    const source = await sharp(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="1" height="1" fill="#ff0000"/><rect x="1" width="1" height="1" fill="#0000ff"/></svg>',
    )).png().toBuffer();
    await writeFile(input, source);

    await new ImageProcessorService().processForEinkWithDithering(input, output, 2, 1, { preserveColor: true });

    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([...data.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...data.subarray(3, 6)]).toEqual([0, 0, 255]);
  });
});
