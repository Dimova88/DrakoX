import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { classNames as cx } from '../lib/format';

export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  return (
    <div className={cx('md', streaming && 'caret', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={streaming ? [] : [[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
