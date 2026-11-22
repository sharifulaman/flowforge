import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Prisma } from '@flowforge/db';
import { type ApiErrorBody, ErrorCode } from '@flowforge/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiException } from '../api-exception';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.BAD_REQUEST,
  415: ErrorCode.BAD_REQUEST,
  429: ErrorCode.RATE_LIMITED,
};

/** Renders every error as ApiErrorBody and logs unexpected ones with the request id. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();

    const { status, body } = this.toBody(exception);
    body.error.requestId = req.id;

    if (status >= 500) {
      req.log.error({ err: exception }, 'Unhandled error');
    } else {
      req.log.debug({ code: body.error.code, status }, body.error.message);
    }
    void reply.status(status).header('content-type', 'application/json; charset=utf-8').send(body);
  }

  private toBody(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof ApiException) {
      return {
        status: exception.getStatus(),
        body: { error: { code: exception.code, message: exception.message, issues: exception.issues } },
      };
    }
    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        body: { error: { code: ErrorCode.RATE_LIMITED, message: 'Too many requests, slow down.' } },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : typeof (res as { message?: unknown }).message === 'string'
            ? (res as { message: string }).message
            : exception.message;
      return {
        status,
        body: { error: { code: STATUS_TO_CODE[status] ?? ErrorCode.INTERNAL, message } },
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          body: { error: { code: ErrorCode.CONFLICT, message: 'A record with these values already exists' } },
        };
      }
      if (exception.code === 'P2025') {
        return {
          status: HttpStatus.NOT_FOUND,
          body: { error: { code: ErrorCode.NOT_FOUND, message: 'Resource not found' } },
        };
      }
    }
    // Fastify errors (body too large, bad JSON, unsupported media type) carry statusCode.
    const fastifyStatus = (exception as { statusCode?: unknown })?.statusCode;
    if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
      return {
        status: fastifyStatus,
        body: {
          error: {
            code: STATUS_TO_CODE[fastifyStatus] ?? ErrorCode.BAD_REQUEST,
            message: (exception as Error).message,
          },
        },
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: { code: ErrorCode.INTERNAL, message: 'Internal server error' } },
    };
  }
}
