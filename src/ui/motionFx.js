// src/ui/motionFx.js
/**
 * Motion AI Kit UI Polish Engine for Orbitune (powered by motion from motion.dev).
 * Provides spring physics, tactile micro-interactions, fluid view transitions,
 * and staggered reveal animations with full prefers-reduced-motion support.
 */
import { animate, press, stagger } from 'motion';

export const isReducedMotion = () => {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
};


/**
 * Smoothly animates an element's appearance using spring physics.
 */
export function springIn(element, { y = 10, scale = 0.98, opacity = 0, visualDuration = 0.35, bounce = 0.18, delay = 0 } = {}) {
  if (!element || isReducedMotion()) {
    if (element) {
      element.style.opacity = '1';
      element.style.transform = 'none';
    }
    return;
  }
  return animate(
    element,
    {
      opacity: [opacity, 1],
      transform: [`translateY(${y}px) scale(${scale})`, 'translateY(0px) scale(1)']
    },
    {
      type: 'spring', visualDuration, bounce,
      delay
    }
  );
}

/**
 * Smooth spring transition when entering a modal dialog or popover.
 */
export function animateDialogIn(dialogEl) {
  if (!dialogEl || isReducedMotion()) return;
  animate(
    dialogEl,
    {
      opacity: [0, 1],
      transform: ['translateY(14px) scale(0.96)', 'translateY(0px) scale(1)'],
      filter: ['blur(6px)', 'blur(0px)']
    },
    {
      type: 'spring', visualDuration: 0.36, bounce: 0.18
    }
  );
}

/**
 * Smooth spring exit for dialogs before closing.
 */
export async function animateDialogOut(dialogEl) {
  if (!dialogEl || isReducedMotion()) return;
  try {
    const anim = animate(
      dialogEl,
      {
        opacity: [1, 0],
        transform: ['translateY(0px) scale(1)', 'translateY(8px) scale(0.97)'],
        filter: ['blur(0px)', 'blur(4px)']
      },
      {
        duration: 0.18,
        ease: 'ease-out'
      }
    );
    await anim.finished;
  } catch {
    // Fallback if animation interrupted
  }
}

/**
 * Smooth transition between the Cluster/Memories/Songs explorer view and Detail view.
 */
export function transitionViews(leavingView, enteringView, direction = 'forward') {
  if (!leavingView || !enteringView) return;
  if (isReducedMotion()) {
    leavingView.hidden = true;
    enteringView.hidden = false;
    return;
  }

  const offset = direction === 'forward' ? 14 : -14;
  enteringView.hidden = false;
  enteringView.style.opacity = '0';
  enteringView.style.transform = `translateX(${offset}px)`;

  animate(
    leavingView,
    { opacity: [1, 0], transform: ['translateX(0px)', `translateX(${-offset}px)`] },
    { duration: 0.15, ease: 'ease-out' }
  ).finished.then(() => {
    leavingView.hidden = true;
    leavingView.style.opacity = '';
    leavingView.style.transform = '';
  }).catch(() => {
    leavingView.hidden = true;
  });

  animate(
    enteringView,
    { opacity: [0, 1], transform: [`translateX(${offset}px)`, 'translateX(0px)'] },
    { type: 'spring', visualDuration: 0.34, bounce: 0.12, delay: 0.04 }
  );
}

/**
 * Staggered spring entrance for list items (clusters, songs, memories).
 */
export function staggerRevealItems(container, itemSelector = 'li', { limit = 24, staggerDelay = 0.02 } = {}) {
  if (!container || isReducedMotion()) return;
  const items = [...container.querySelectorAll(itemSelector)].slice(0, limit);
  if (!items.length) return;

  items.forEach(item => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(8px)';
  });

  animate(
    items,
    {
      opacity: [0, 1],
      transform: ['translateY(8px)', 'translateY(0px)']
    },
    {
      delay: stagger(staggerDelay, { startDelay: 0.02 }),
      type: 'spring', visualDuration: 0.32, bounce: 0.14
    }
  );
}

/**
 * Animates the year-by-year sparkbar chart rising up on render.
 */
export function animateSparkbars(chartEl) {
  if (!chartEl || isReducedMotion()) return;
  const fills = chartEl.querySelectorAll('.year-bar-fill');
  if (!fills.length) return;

  fills.forEach(fill => {
    fill.style.transformOrigin = 'bottom';
    fill.style.transform = 'scaleY(0)';
  });

  animate(
    [...fills],
    {
      transform: ['scaleY(0)', 'scaleY(1)']
    },
    {
      delay: stagger(0.035, { startDelay: 0.06 }),
      type: 'spring', visualDuration: 0.4, bounce: 0.2
    }
  );
}

/**
 * Attaches tactile Motion spring press feedback across interactive UI elements.
 */
export function attachPressFeedback(target, { scale = 0.96 } = {}) {
  if (isReducedMotion()) return;
  try {
    press(target, (element) => {
      animate(element, { transform: `scale(${scale})` }, { duration: 0.09, ease: 'ease-out' });
      return () => {
        animate(element, { transform: 'scale(1)' }, { type: 'spring', visualDuration: 0.3, bounce: 0.22 });
      };
    });
  } catch {
    // Graceful fallback if selector or element is invalid
  }
}
