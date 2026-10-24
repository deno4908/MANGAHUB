import { useId, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Circle, Eye, EyeOff, Lock } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { assessPassword, type PasswordAssessment } from '@/lib/passwordPolicy';

export function usePasswordAssessment(password: string) {
  return useMemo(() => assessPassword(password), [password]);
}

type Props = {
  password: string;
  confirmation: string;
  onPasswordChange: (value: string) => void;
  onConfirmationChange: (value: string) => void;
  assessment: PasswordAssessment;
  passwordLabel?: string;
  disabled?: boolean;
};

export function NewPasswordFields({ password, confirmation, onPasswordChange, onConfirmationChange,
  assessment, passwordLabel = 'Mật khẩu mới', disabled = false }: Props) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const matches = password === confirmation;
  const rules = [
    { label: 'Từ 8 đến 128 ký tự', valid: assessment.lengthValid },
    { label: 'Không dùng mật khẩu phổ biến hoặc mẫu dễ đoán', valid: assessment.score >= 3 },
  ];
  return <div className="space-y-4">
    <div className="space-y-2">
      <label htmlFor={`${id}-password`} className="text-sm font-medium text-foreground">{passwordLabel}</label>
      <div className="relative">
        <Lock aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input id={`${id}-password`} type={visible ? 'text' : 'password'} autoComplete="new-password"
          placeholder="Tối thiểu 8 ký tự" value={password} onChange={event => onPasswordChange(event.target.value)}
          className="pl-10 pr-10" minLength={8} required disabled={disabled}
          aria-describedby={password ? `${id}-requirements` : undefined} />
        <button type="button" aria-label={visible ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} aria-pressed={visible}
          disabled={disabled} onClick={() => setVisible(value => !value)}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {visible ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {password.length > 0 && <motion.div key="requirements" id={`${id}-requirements`}
          initial={reduceMotion ? false : { opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }} transition={{ duration: reduceMotion ? 0 : 0.2 }} className="overflow-hidden">
          <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-3">
            <ul aria-label="Yêu cầu mật khẩu" className="space-y-2">
              {rules.map(rule => <motion.li key={rule.label} layout={!reduceMotion}
                className={`flex items-start gap-2 text-xs transition-colors ${rule.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
                <motion.span key={String(rule.valid)} initial={reduceMotion ? false : { scale: 0.8 }} animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 18, duration: reduceMotion ? 0 : undefined }} className="mt-0.5 shrink-0">
                  {rule.valid ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" /> : <Circle aria-hidden="true" className="h-3.5 w-3.5" />}
                </motion.span>
                <span>{rule.label}<span className="sr-only">{rule.valid ? ': Đạt' : ': Chưa đạt'}</span></span>
              </motion.li>)}
            </ul>
          </div>
        </motion.div>}
      </AnimatePresence>
    </div>
    <div className="space-y-2">
      <label htmlFor={`${id}-confirm`} className="text-sm font-medium text-foreground">Xác nhận mật khẩu</label>
      <div className="relative">
        <Lock aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input id={`${id}-confirm`} type={visible ? 'text' : 'password'} autoComplete="new-password"
          placeholder="Nhập lại mật khẩu" value={confirmation} onChange={event => onConfirmationChange(event.target.value)}
          className="pl-10" required disabled={disabled} aria-invalid={Boolean(confirmation) && !matches}
          aria-describedby={confirmation ? `${id}-match` : undefined} />
      </div>
      <AnimatePresence initial={false}>
        {confirmation.length > 0 && <motion.p key="match" id={`${id}-match`} role="status" aria-live="polite"
          initial={reduceMotion ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.2 }}
          className={`flex items-center gap-2 text-xs ${matches ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
          {matches ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" /> : <Circle aria-hidden="true" className="h-3.5 w-3.5" />}
          {matches ? 'Mật khẩu khớp' : 'Mật khẩu không khớp'}
        </motion.p>}
      </AnimatePresence>
    </div>
  </div>;
}
