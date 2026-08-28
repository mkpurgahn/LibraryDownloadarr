import { Request, Response } from 'express';

export const SESSION_COOKIE = 'librarydownloadarr_session';

export const readSessionCookie = (req: Request): string | undefined => {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const setSessionCookie = (req: Request, res: Response, token: string): void => {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
};

export const clearSessionCookie = (req: Request, res: Response): void => {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/',
  });
};
