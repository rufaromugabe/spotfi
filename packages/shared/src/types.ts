import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['ADMIN', 'HOST']).default('HOST'),
});

export const RouterCreateSchema = z.object({
  name: z.string().min(1),
  hostId: z.string().min(1), // Required: router must have a host
  nasipaddress: z.string().ip().optional(),
  location: z.string().optional(),
});

export const RouterCommandSchema = z.object({
  command: z.enum(['reboot', 'fetch-logs', 'get-status', 'update-config']),
  params: z.record(z.unknown()).optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type RegisterInput = z.infer<typeof RegisterSchema>;
export type RouterCreateInput = z.infer<typeof RouterCreateSchema>;
export type RouterCommandInput = z.infer<typeof RouterCommandSchema>;

