export interface IssueNote {
  author: string;
  created: string;
  bodyMarkdown: string;
}

export interface IssueFile {
  filename: string;
  path: string;
  url: string | null;
  body: string | null;
  encoding: 'utf8' | 'base64';
}

export interface IssueLink {
  url: string;
  path: string;
  source: 'link' | 'paste';
  body: string | null;
  encoding: 'utf8' | 'base64';
}

export interface IssuePage {
  source: 'confluence' | 'drive';
  id: string;
  title: string;
  path: string;
  url: string;
  body: string;
  encoding: 'utf8' | 'base64';
}

export interface IssueEpic {
  key: string;
  summary: string;
  descriptionMarkdown: string;
  comments: IssueNote[];
}

export interface IssueBundle {
  key: string;
  summary: string;
  descriptionMarkdown: string;
  acceptanceCriteria: string;
  epic: IssueEpic | null;
  comments: IssueNote[];
  attachments: IssueFile[];
  links: IssueLink[];
  confluence: IssuePage[];
  pages: IssuePage[];
}
