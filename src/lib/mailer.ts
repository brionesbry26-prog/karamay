/**
 * Outbound email abstraction. Only a development outbox exists today; a real
 * provider adapter must be added before accounts can be enabled in production
 * (see docs/DEPLOYMENT.md, "Email delivery"). Mail bodies and links are never
 * logged because they contain single-use credentials.
 */
export type MailKind = 'verify_registration' | 'already_registered' | 'password_reset' | 'password_changed';

export interface MailMessage {
  to: string;
  kind: MailKind;
  link?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export class DevOutboxMailer implements Mailer {
  readonly outbox: MailMessage[] = [];

  async send(msg: MailMessage): Promise<void> {
    this.outbox.push(msg);
    if (this.outbox.length > 200) this.outbox.shift();
  }

  lastFor(to: string, kind?: MailKind): MailMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to && (!kind || m.kind === kind));
  }
}

export class DisabledMailer implements Mailer {
  async send(): Promise<void> {
    throw new Error('email delivery is not configured');
  }
}
