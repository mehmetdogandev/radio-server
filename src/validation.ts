import { body, param, query, validationResult } from 'express-validator';
import type { Request, Response, NextFunction } from 'express';

const MESSAGE_MAX_LENGTH = Number(process.env.MESSAGE_MAX_LENGTH ?? 500);

export const validateRequest = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Geçersiz istek', details: errors.array() });
    return;
  }
  next();
};

export const sanitizeMessage = (content: string): string => {
  // Remove any HTML tags
  let sanitized = content.replace(/<[^>]*>/g, '');
  
  // Trim and limit length
  sanitized = sanitized.trim();
  if (sanitized.length > MESSAGE_MAX_LENGTH) {
    sanitized = sanitized.slice(0, MESSAGE_MAX_LENGTH);
  }
  
  return sanitized;
};

export const validateUserSync = [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('İsim 1-100 karakter olmalı'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Geçerli email gerekli'),
  body('password').optional().isLength({ min: 6, max: 128 }).withMessage('Şifre 6-128 karakter olmalı'),
  body('passwordHash').optional().isString().withMessage('passwordHash string olmalı'),
  body('role').optional().isIn(['admin', 'user']).withMessage('Role admin veya user olmalı'),
  validateRequest,
];

export const validateCreateChat = [
  body('name').trim().isLength({ min: 1, max: 100 }).withMessage('Grup adı 1-100 karakter olmalı'),
  body('isGroup').optional().isBoolean().withMessage('isGroup boolean olmalı'),
  body('chatType').optional().isIn(['chat', 'voice']).withMessage('chatType chat veya voice olmalı'),
  validateRequest,
];

export const validateSendMessage = [
  param('chatId').isInt({ min: 1 }).withMessage('Geçersiz chat ID'),
  body('content').trim().isLength({ min: 1, max: MESSAGE_MAX_LENGTH })
    .withMessage(`Mesaj 1-${MESSAGE_MAX_LENGTH} karakter olmalı`),
  body('clientMsgId').trim().isLength({ min: 1, max: 100 }).withMessage('clientMsgId gerekli'),
  validateRequest,
];

export const validateChatId = [
  param('chatId').isInt({ min: 1 }).withMessage('Geçersiz chat ID'),
  validateRequest,
];

export const validateJoinRequest = [
  param('chatId').isInt({ min: 1 }).withMessage('Geçersiz chat ID'),
  validateRequest,
];

export const validatePagination = [
  query('after').optional().isInt({ min: 0 }).withMessage('after 0 veya daha büyük olmalı'),
  query('before').optional().isInt({ min: 0 }).withMessage('before 0 veya daha büyük olmalı'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit 1-100 arası olmalı'),
  validateRequest,
];

export const validateRequestId = [
  param('id').isInt({ min: 1 }).withMessage('Geçersiz istek ID'),
  validateRequest,
];
