import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfig } from '../config/app-config';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * SMTP mail (mailpit in dev). With MAIL_TRANSPORT=noop nothing leaves the process and
 * messages are kept in `sent` so tests can read set-password links.
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  readonly sent: MailMessage[] = [];

  constructor(private readonly cfg: AppConfig) {
    this.transporter =
      cfg.MAIL_TRANSPORT === 'noop'
        ? null
        : nodemailer.createTransport({
            host: cfg.SMTP_HOST,
            port: cfg.SMTP_PORT,
            secure: cfg.SMTP_SECURE,
            auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS ?? '' } : undefined,
          });
  }

  /** Never throws: a mail outage must not fail the business action. Returns success. */
  async send(message: MailMessage): Promise<boolean> {
    if (!this.transporter) {
      this.sent.push(message);
      if (this.sent.length > 200) this.sent.shift();
      return true;
    }
    try {
      await this.transporter.sendMail({ from: this.cfg.MAIL_FROM, ...message });
      return true;
    } catch (err) {
      this.logger.warn(`Mail delivery failed: ${(err as Error).message}`);
      return false;
    }
  }

  onModuleDestroy(): void {
    this.transporter?.close();
  }
}
