import { BadRequestException, Body, Controller, Post, Query } from '@nestjs/common';
import type { UploadView } from '../contract/attachments';
import { AttachmentStore } from '../history/attachment-store';

@Controller()
export class UploadsController {
  constructor(private readonly attachments: AttachmentStore) {}

  /** Keeps one file for a message or a new run to take by its id. The body parser of this route caps the size. */
  @Post('uploads')
  upload(@Query('name') name: unknown, @Body() bytes: unknown): Promise<UploadView> {
    if (typeof name !== 'string' || !name.trim()) {
      throw new BadRequestException('name is missing');
    }
    return this.attachments.stage(name.trim(), Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0));
  }
}
