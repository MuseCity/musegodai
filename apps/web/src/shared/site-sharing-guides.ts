import type { SiteBuilderId } from "./site-builders";

// Official-source guidance reviewed on 2026-09-28.
export const siteSharingGuides = {
  codex: {
    intro:
      "OpenAI's current documentation calls this feature ChatGPT Sites. It lets you create, preview, publish and share interactive websites and lightweight apps from ChatGPT Work or the Codex desktop app. Publishing a site makes the project accessible; sharing it on musegod.ai gives it a place for discovery, feedback and a conversation with its creator.",
    sections: [
      {
        title: "Publish the site in ChatGPT or Codex",
        text: "Open your site project and review its preview. Use the site's publishing controls to choose an audience. If your account and workspace allow public publishing, select Anyone on the Internet and publish. Use Visit or Copy link to get the published address. Access and publishing options vary by plan and workspace policy; ask your workspace admin if the public option is unavailable.",
      },
      {
        title: "Test the published address as a visitor",
        text: "Open the link in a signed-out browser and try the main interaction. A preview inside your workspace is not proof that another person can use the published site. If the site has its own login or other access requirements, describe them in your submission. Check the phone layout, remove private data, and capture a cover that shows the actual project.",
      },
      {
        title: "Give visitors something to try",
        text: "Explain who the site is for, what a visitor can do, and one useful detail about how you made it. For example, a trip-planning tool could explain its inputs, how to compare two itineraries, and which data is only a demonstration. Share your actual build notes or a useful prompt excerpt, rather than a list of keywords. Keep the external site available after submitting it.",
      },
    ],
    sources: [
      {
        label: "OpenAI: Creating and managing ChatGPT Sites",
        url: "https://help.openai.com/en/articles/20001339-creating-and-managing-chatgpt-sites",
      },
      {
        label: "OpenAI: Sites guide",
        url: "https://learn.chatgpt.com/docs/sites",
      },
    ],
  },
  claude: {
    intro:
      "Claude Artifacts can contain interactive web projects and small tools. Sharing controls depend on whether your Artifact uses the current sharing flow or the legacy Publish flow. A link that works for you may still require your visitor to sign in or belong to your organization.",
    sections: [
      {
        title: "Use the sharing controls your Artifact actually shows",
        text: "For a current Artifact, open Share, review Who has access, choose the intended audience and use Copy link. Pro and Max accounts can choose Anyone with the link where supported. Team and Enterprise external sharing depends on an owner's or admin's settings. Current shared Artifacts require a Claude account even when Anyone with the link is selected. Artifacts that use apps or Claude can have additional sharing restrictions.",
      },
      {
        title: "Check whether you have a legacy published Artifact",
        text: "Some older Artifacts created in chat show Publish instead. Anthropic documents public publishing for this legacy flow on Free, Pro and Max: visitors can view and use the published Artifact without a Claude account, while AI-powered features can still require sign-in. Organization sharing follows separate rules. Check the official guide and your actual interface instead of assuming every Artifact has the same access model.",
      },
      {
        title: "Make the access requirement clear",
        text: "Test your link with an account outside your workspace, or signed out for a legacy public link. Explain whether visitors need Claude and whether AI features need their own access. Show the usable interface in your cover and describe a concrete action to try. An interactive study guide might identify its subject, how to start a quiz, and whether answers are generated live. Publish only web projects here; a private conversation URL does not give visitors access to its Artifact.",
      },
    ],
    sources: [
      {
        label: "Anthropic: Share Artifacts (including legacy publishing)",
        url: "https://support.claude.com/en/articles/9547008-share-artifacts",
      },
    ],
  },
  muse: {
    intro:
      "Meta describes Muse as a personal AI agent with its own computer. Its design overview includes web pages, dashboards, study guides and rich interactive outputs called Artifacts. Here, Muse means Meta Muse; musegod.ai is an independent community. The official sources reviewed below establish creation capabilities, but do not describe a general public-hosting service equivalent to ChatGPT Sites.",
    sections: [
      {
        title: "Separate the Artifact from its hosting",
        text: "First check what Muse produced: a web page, a working app, source files, or an output available only inside your conversation. If your account offers a shareable web address, review its audience settings. Otherwise, publish the generated web project through a hosting service you control. Source files or a screenshot alone are not a website URL, and a local development address will not work for other visitors.",
      },
      {
        title: "Verify access before posting the link",
        text: "Open the HTTPS address as a visitor and test the main feature on a phone as well as a computer. Explain any login, invitation or data requirements. Do not assume there is a universal Muse Publish button or that sharing a chat publishes its outputs. Use the official product documentation and the controls available in your account to determine what can be shared.",
      },
      {
        title: "Describe Muse's role in the project",
        text: "Tell visitors what Muse helped create and what you edited or hosted yourself. A personal dashboard might describe its sample data, which controls work, and whether the displayed numbers are live. Do not include private records or credentials in your cover or build notes. Use Meta Muse or Muse Artifacts in Made with so the community can find your project under the right source.",
      },
    ],
    sources: [
      {
        label: "Meta: How we designed Muse",
        url: "https://introducing.muse.ai/",
      },
      {
        label: "Meta: Muse product overview",
        url: "https://ai.meta.com/muse/",
      },
    ],
  },
} satisfies Record<
  SiteBuilderId,
  {
    intro: string;
    sections: { title: string; text: string }[];
    sources: { label: string; url: string }[];
  }
>;
