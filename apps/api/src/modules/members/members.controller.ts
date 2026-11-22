import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { type AddMemberInput, addMemberSchema, type MemberDto, type UpdateMemberInput, updateMemberSchema } from '@flowforge/shared';
import { CurrentUserId, CurrentWorkspace, Roles } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import type { WorkspaceContext } from '../../types/principal';
import { MembersService } from './members.service';

@Controller('workspaces/:workspaceId/members')
@UseGuards(WorkspaceGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceContext): Promise<MemberDto[]> {
    return this.members.list(ws.id);
  }

  @Post()
  @Roles('ADMIN')
  add(@CurrentWorkspace() ws: WorkspaceContext, @Body(new ZodPipe(addMemberSchema)) body: AddMemberInput): Promise<MemberDto> {
    return this.members.add(ws, body);
  }

  @Patch(':memberId')
  @Roles('ADMIN')
  update(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('memberId') memberId: string,
    @Body(new ZodPipe(updateMemberSchema)) body: UpdateMemberInput,
  ): Promise<MemberDto> {
    return this.members.update(ws, memberId, body);
  }

  @Delete(':memberId')
  @HttpCode(204)
  remove(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('memberId') memberId: string,
    @CurrentUserId() userId: string,
  ): Promise<void> {
    return this.members.remove(ws, memberId, userId);
  }
}
