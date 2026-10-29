export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new ApiError(status, code, message, details);
}

export function toPublicError(error, requestId) {
  if (['55P03','57014','53300','57P01','57P02','57P03','08001','08003','08006','ECONNRESET','ETIMEDOUT','ECONNREFUSED'].includes(error?.code) || (error?.code === 'ERR_SQLITE_ERROR' && [5,6].includes(error.errcode))) {
    return {status: 503, body: {ok: false, error: {code: 'DATABASE_BUSY', message: 'O armazenamento está ocupado ou temporariamente indisponível. Tente novamente.', requestId}}};
  }
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), requestId } },
    };
  }
  return {
    status: 500,
    body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a operação.', requestId } },
  };
}
