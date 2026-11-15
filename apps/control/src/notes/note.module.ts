import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

@Module({
  imports: [AuthModule],
  controllers: [NoteController],
  providers: [NoteService],
  exports: [NoteService],
})
export class NoteModule {}
