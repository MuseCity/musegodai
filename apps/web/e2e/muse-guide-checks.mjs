// Shared DOM assertions for the browser script and Chrome DevTools acceptance.
export function checkPublicMuseGuide({
  id,
  name,
  origin,
  invite,
  state,
  message,
  started = false,
}) {
  let checks = 0;
  const assert = (condition, label) => {
    if (!condition) throw new Error(`Public guide: ${label}`);
    checks++;
  };
  const card = document.querySelector(".muse-start");
  assert(
    !document.querySelector(".muse-keeper-prompt"),
    "no separate keeper panel",
  );
  assert(
    !document.querySelector("[data-muse-copy]"),
    "no private copy controls",
  );
  assert(!document.querySelector(".muse-live"), "no live keeper progress");
  assert(
    !/mcr_/.test(document.querySelector(".muse-page").textContent),
    "no private code",
  );
  assert(
    document.documentElement.scrollWidth <= innerWidth,
    "no horizontal overflow",
  );
  if (started) {
    assert(!card, "no guide for a started muse's non-keeper");
    return { state, started, checks };
  }
  assert(
    !performance
      .getEntriesByType("resource")
      .some((entry) =>
        /\/api\/v1\/me\/muses\/\d+\/start$/.test(new URL(entry.name).pathname),
      ),
    "no start request",
  );

  assert(
    card?.querySelector("h2")?.textContent === `Wake up ${name}`,
    "guide heading",
  );
  assert(
    JSON.stringify(
      [...card.querySelectorAll("h3")].map((h) => h.textContent),
    ) ===
      JSON.stringify([
        "1. Get Muse",
        "2. Give Muse this line",
        `3. Watch ${name} set up`,
      ]),
    "three steps in order",
  );
  assert(
    card.querySelector('a[target="_blank"]').href === invite.url,
    "shared invite URL",
  );
  assert(
    card
      .querySelector(".muse-invite")
      .textContent.includes(`Invite code ${invite.code}`),
    "shared invite code",
  );
  assert(
    card.querySelector("[data-muse-invite-copy]")?.textContent.trim() ===
      "copy code",
    "invite copy action",
  );
  assert(
    card.querySelector(".muse-line-preview")?.textContent ===
      `Be muse #${id} (read https://musegod.org/muse/${id}.txt), then set yourself up by following ${origin}/muses/${id}/start.md with code <your code>`,
    "exact placeholder line",
  );
  const placeholder = card.querySelector(".muse-code-placeholder");
  assert(placeholder?.textContent === "<your code>", "placeholder text");
  assert(
    getComputedStyle(placeholder).borderTopStyle === "dashed",
    "distinct placeholder",
  );
  assert(
    card.textContent.includes(
      `Your Muse reads ${name}'s soul, takes its name and look, moves into musegod.ai and joins the places muses live. This page updates while it works; you only approve and sign.`,
    ),
    "static third step",
  );
  assert(
    card.querySelector(".muse-find")?.textContent.trim() === "Find my muses",
    "find inside guide",
  );
  assert(
    document.querySelector(".muse-started").nextElementSibling.contains(card),
    "guide below progress",
  );
  const access = card.querySelector(".muse-keeper-access");
  if (state === "signed-out") {
    assert(
      access.querySelector(".primary")?.textContent.trim() === "Connect wallet",
      "login action",
    );
    assert(
      access.textContent.includes(
        `Only the wallet that holds ${name} can get its code.`,
      ),
      "holder note",
    );
    assert(card.querySelector(".muse-find button"), "find opens login");
  } else if (state === "checking") {
    assert(
      access.querySelector('[role="status"]')?.textContent ===
        `Checking whether you hold ${name}…`,
      "checking status",
    );
  } else if (state === "non-keeper") {
    assert(
      access.textContent.includes(
        `None of the wallets on your account holds ${name}.`,
      ),
      "non-keeper explanation",
    );
    assert(
      access.querySelector(".primary")?.textContent.trim() ===
        `Connect the wallet that holds ${name}`,
      "link action",
    );
    assert(
      access.querySelector(".secondary")?.textContent.trim() === "Check again",
      "recheck action",
    );
  } else {
    assert(
      access.querySelector('[role="alert"]')?.textContent === message,
      "error message",
    );
    assert(
      access.querySelector(".primary")?.textContent.trim() === "Try again",
      "retry action",
    );
  }
  return { state, started, checks };
}

export function checkPublicMuseInvite({ invite, layout }) {
  let checks = 0;
  const assert = (condition, label) => {
    if (!condition) throw new Error(`Public invite: ${label}`);
    checks++;
  };
  const blocks = document.querySelectorAll("[data-muse-invite]");
  assert(blocks.length === 1, "exactly one invite block");
  const block = blocks[0];
  const link = block.querySelector("a");
  assert(link?.href === invite.url, "shared invite URL");
  assert(link?.target === "_blank", "invite opens separately");
  assert(
    block.querySelector(".muse-invite p")?.textContent ===
      `Invite code ${invite.code}: redeem it in Muse Settings within 48 hours of joining. You and the musegod.ai team each get 1 billion Muse tokens.`,
    "exact shared invite text",
  );
  assert(
    block.querySelector("[data-muse-invite-copy]")?.textContent.trim() ===
      "copy code",
    "copy action",
  );
  if (layout === "unstarted") {
    assert(block.closest(".muse-start"), "invite inside guide step 1");
    assert(
      !document.querySelector(".muse-invite-panel"),
      "no duplicate compact block",
    );
  } else {
    assert(block.matches(".muse-panel.muse-invite-panel"), "compact panel");
    assert(
      block.querySelector("h2")?.textContent === "Get Muse",
      "compact heading",
    );
    if (layout === "directory") {
      assert(
        block.previousElementSibling.matches("p.muse-note"),
        "below directory intro",
      );
      assert(
        block.nextElementSibling.matches(".muse-search"),
        "above directory search",
      );
    } else {
      assert(
        block.previousElementSibling.matches(".muse-started"),
        "below progress",
      );
      assert(
        !document.querySelector(".muse-start"),
        "started visitor has no guide",
      );
    }
  }
  assert(
    document.documentElement.scrollWidth <= innerWidth,
    "no horizontal overflow",
  );
  return { layout, checks };
}

export async function exerciseMuseInviteCopy({ code }) {
  const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const copies = [];
  let denied = false;
  const wait = async (condition) => {
    const end = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() > end)
        throw new Error("Invite copy feedback did not update");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  // Wait for signed-out fixture hydration before retaining an SSR element.
  await wait(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Join" && !button.disabled,
    ),
  );
  const button = document.querySelector("[data-muse-invite-copy]");
  const block = button.closest("[data-muse-invite]");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        if (denied) throw new Error("Local clipboard denial");
        copies.push(text);
      },
    },
  });
  try {
    button.click();
    await wait(
      () =>
        block.querySelector('[role="status"]')?.textContent === "Code copied",
    );
    if (copies.length !== 1 || copies[0] !== code)
      throw new Error("Wrong invite copied");
    denied = true;
    button.click();
    await wait(() => block.querySelector('[role="alert"]'));
    if (
      block.querySelector('[role="alert"]').textContent !==
        "Copy failed. Select the invite code above and copy it manually." ||
      block.querySelector('[role="status"]') ||
      copies.length !== 1
    )
      throw new Error("Wrong invite copy failure feedback");
    denied = false;
    button.click();
    await wait(
      () =>
        block.querySelector('[role="status"]')?.textContent === "Code copied" &&
        !block.querySelector('[role="alert"]'),
    );
    if (copies.length !== 2 || copies[1] !== code)
      throw new Error("Invite copy recovery failed");
    if (
      performance
        .getEntriesByType("resource")
        .some((entry) =>
          /\/api\/v1\/me\/muses\/\d+\/start$/.test(
            new URL(entry.name).pathname,
          ),
        )
    )
      throw new Error("Invite copy created an Agent code");
    return {
      copied: true,
      failedFeedback: true,
      recovered: true,
      noStartRequest: true,
    };
  } finally {
    if (previous) Object.defineProperty(navigator, "clipboard", previous);
    else delete navigator.clipboard;
  }
}
