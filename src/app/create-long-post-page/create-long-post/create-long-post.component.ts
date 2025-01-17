// @ts-strict
import { Location } from "@angular/common";
import { AfterViewInit, Component, ElementRef, ViewChild } from "@angular/core";
import { Title } from "@angular/platform-browser";
import { ActivatedRoute, Router } from "@angular/router";
import { TranslocoService } from "@ngneat/transloco";
import { escape, has } from "lodash";
import { ToastrService } from "ngx-toastr";
import "quill-mention";
import { BackendApiService, GetSinglePostResponse, ProfileEntryResponse } from "src/app/backend-api.service";
import { GlobalVarsService } from "src/app/global-vars.service";
import { environment } from "src/environments/environment";
import { dataURLtoFile, fileToDataURL } from "src/lib/helpers/data-url-helpers";

const RANDOM_MOVIE_QUOTES = [
  "feed_create_post.quotes.quote1",
  "feed_create_post.quotes.quote2",
  "feed_create_post.quotes.quote3",
  "feed_create_post.quotes.quote4",
  "feed_create_post.quotes.quote5",
  "feed_create_post.quotes.quote6",
  "feed_create_post.quotes.quote7",
  "feed_create_post.quotes.quote8",
  "feed_create_post.quotes.quote9",
  "feed_create_post.quotes.quote10",
  "feed_create_post.quotes.quote11",
  "feed_create_post.quotes.quote12",
  "feed_create_post.quotes.quote13",
  "feed_create_post.quotes.quote14",
  "feed_create_post.quotes.quote15",
  "feed_create_post.quotes.quote16",
  "feed_create_post.quotes.quote17",
  "feed_create_post.quotes.quote18",
];

export interface BlogPostExtraData {
  Title: string;
  Description: string;
  BlogDeltaRtfFormat: string;
  BlogTitleSlug: string;
  CoverImage: string;
  Node?: string;
  Language?: string;
}

class FormModel {
  Title = "";
  Description = "";
  ContentDelta: any = null;
  CoverImage = "";
  errors: string[] = [];

  get hasErrors() {
    return this.errors.length > 0;
  }

  validate() {
    if (this.Title.trim() === "") {
      this.errors.push("Headline is a required field!");
    }
    if (!this.ContentDelta?.ops) {
      this.errors.push("Blog content is required field!");
    }
  }

  clearErrors() {
    this.errors = [];
  }
}

interface MentionRenderItem {
  id: string;
  value: string;
}

@Component({
  selector: "create-long-post",
  templateUrl: "./create-long-post.component.html",
  styleUrls: ["./create-long-post.component.scss"],
})
export class CreateLongPostComponent implements AfterViewInit {
  @ViewChild("coverImgInput") coverImgInput?: ElementRef<HTMLInputElement>;
  @ViewChild("titleInput") titleInput?: ElementRef<HTMLInputElement>;

  imagePreviewDataURL?: string;
  coverImageFile?: File;
  model = new FormModel();
  isDraggingFileOverDropZone = false;
  isSubmittingPost = false;
  isLoadingEditModel: boolean;
  placeholder = RANDOM_MOVIE_QUOTES[Math.floor(Math.random() * RANDOM_MOVIE_QUOTES.length)];
  contentAsPlainText?: string;
  private profilesByPublicKey: Record<string, ProfileEntryResponse> = {};

  quillModules = {
    toolbar: [
      ["bold", "italic", "underline", "strike"], // toggled buttons
      ["blockquote", "code-block"],
      [{ list: "ordered" }, { list: "bullet" }],
      [{ script: "super" }],
      [{ header: [1, 2, 3, false] }],
      ["link", "image"],
    ],
    mention: {
      allowedChars: /^[\w]*$/,
      mentionDenotationChars: ["@", "$"],
      source: async (searchTerm: string, renderList: (values: any, searchTerm: string) => void) => {
        if (searchTerm.length === 0) return;
        const profiles = await this.getUsersFromMentionPrefix(searchTerm);
        const renderItems: MentionRenderItem[] = [];
        profiles.forEach((p) => {
          this.profilesByPublicKey[p.PublicKeyBase58Check!] = p;
          renderItems.push({ id: p.PublicKeyBase58Check!, value: p.Username });
        });
        renderList(renderItems, searchTerm);
      },
      renderItem: (item: MentionRenderItem) => {
        const profile = this.profilesByPublicKey[item.id];
        const profPicURL = this.backendApi.GetSingleProfilePictureURL(
          this.globalVars.localNode,
          profile.PublicKeyBase58Check ?? "",
          `fallback=${this.backendApi.GetDefaultProfilePictureURL(window.location.host)}`
        );
        return `<div class="menu-item">
          <div class="d-flex align-items-center">
            <img src="${escape(profPicURL)}" height="30px" width="30px" style="border-radius: 10px" class="mr-5px">
            <p>${escape(profile.Username)}</p>
            ${profile.IsVerified ? `<i class="fas fa-check-circle fa-md ml-5px fc-blue"></i>` : ""}
          </div>
        </div>`;
      },
    },
  };

  get coverImgSrc() {
    return this.imagePreviewDataURL ?? this.model.CoverImage;
  }

  get editPostHashHex() {
    return this.route.snapshot.params?.postHashHex ?? "";
  }

  constructor(
    private backendApi: BackendApiService,
    private globalVars: GlobalVarsService,
    private route: ActivatedRoute,
    private router: Router,
    private titleService: Title,
    private toastr: ToastrService,
    private location: Location,
    private translocoService: TranslocoService
  ) {
    this.isLoadingEditModel = !!this.route.snapshot.params?.postHashHex;
  }

  async ngAfterViewInit() {
    this.titleService.setTitle(`Publish Blog Post`);

    if (this.editPostHashHex) {
      try {
        const editPost = await this.getBlogPostToEdit(this.editPostHashHex);
        if (editPost.PostFound?.PostExtraData?.BlogDeltaRtfFormat) {
          const editPostData = editPost.PostFound?.PostExtraData as BlogPostExtraData;
          const contentDelta = JSON.parse(editPostData.BlogDeltaRtfFormat);
          Object.assign(this.model, { ...editPostData, ContentDelta: contentDelta });
          this.contentAsPlainText = contentDelta.ops.reduce(
            (text: string, op: any) => `${text}${typeof op.insert === "string" ? op.insert : ""}`,
            ""
          );
        }
      } catch (e) {
        // This is assuming 404 which might hide other types of errors, but this is currently what the
        // post thread page does...
        this.router.navigateByUrl("/" + this.globalVars.RouteNames.NOT_FOUND, { skipLocationChange: true });
      }
    }

    this.isLoadingEditModel = false;
    this.titleInput?.nativeElement?.focus();
  }

  async getUsersFromMentionPrefix(prefix: string): Promise<ProfileEntryResponse[]> {
    const profiles = await this.backendApi
      .GetProfiles(
        this.globalVars.localNode,
        "" /*PublicKeyBase58Check*/,
        "" /*Username*/,
        prefix.trim().replace(/^@/, "") /*UsernamePrefix*/,
        "" /*Description*/,
        "influencer_coin_price" /*Order by*/,
        5 /*NumToFetch*/,
        this.globalVars.loggedInUser.PublicKeyBase58Check /*ReaderPublicKeyBase58Check*/,
        "" /*ModerationType*/,
        false /*FetchUsersThatHODL*/,
        false /*AddGlobalFeedBool*/
      )
      .toPromise();
    return profiles.ProfilesFound as ProfileEntryResponse[];
  }

  async getBlogPostToEdit(blogPostHashHex: string): Promise<GetSinglePostResponse> {
    return this.backendApi
      .GetSinglePost(
        this.globalVars.localNode,
        blogPostHashHex /*PostHashHex*/,
        this.globalVars.loggedInUser?.PublicKeyBase58Check ?? "" /*ReaderPublicKeyBase58Check*/,
        false /*FetchParents */,
        0 /*CommentOffset*/,
        0 /*CommentLimit*/,
        this.globalVars.showAdminTools() /*AddGlobalFeedBool*/,
        0 /*ThreadLevelLimit*/,
        0 /*ThreadLeafLimit*/,
        false /*LoadAuthorThread*/
      )
      .toPromise();
  }

  onContentChange(content: any) {
    this.contentAsPlainText = content.text;
  }

  async postProcessDelta({ ops }: { ops: any[] }): Promise<{ ops: any[] }> {
    const processedOps = await Promise.all(
      ops.map(async (op: any) => {
        // convert any images from base64 to a File object, upload them, and then replace
        // that image in the Delta object with the link to the uploaded image.
        // This is done to drastically reduce on-chain file size.
        if (has(op, "insert.image") && op.insert.image.substring(0, 5) === "data:") {
          const newFile = dataURLtoFile(op.insert.image, "uploaded_image");
          const res = await this.backendApi
            .UploadImage(environment.uploadImageHostname, this.globalVars.loggedInUser.PublicKeyBase58Check, newFile)
            .toPromise();
          op.insert.image = res.ImageURL;
        }

        // convert mentions to regular links, since mention operations are a
        // custom op added by the quill mention plugin. On the output side, any
        // app can modify the link if needed but we've chose a widely used
        // convention of `/u/<username>` as the default.
        if (!!op.insert?.mention) {
          const { value, denotationChar } = op.insert.mention;
          return {
            attributes: { link: `/u/${value}` },
            insert: `${denotationChar}${value}`,
          };
        }

        return op;
      })
    );

    return { ops: processedOps };
  }

  async submit(ev: Event) {
    ev.preventDefault();
    if (this.isSubmittingPost) return;

    const currentUserProfile = this.globalVars.loggedInUser?.ProfileEntryResponse;

    if (!currentUserProfile) {
      this.globalVars._alertError("You must have a profile to create a blog post.");
      return;
    }

    currentUserProfile.ExtraData = currentUserProfile.ExtraData ?? {};

    // check if the user has enough funds to execute the 2 transactions we need to create a blog post:
    // - 1 create the post
    // - 2 update the user profile with the slug -> profileHashHex mapping
    if ((this.globalVars.loggedInUser?.BalanceNanos ?? 0) < this.globalVars.defaultFeeRateNanosPerKB * 2) {
      this.globalVars._alertError(
        `You don't have enough $DESO to create a blog post. The minimum amount needed is ${
          (this.globalVars.defaultFeeRateNanosPerKB * 2) / 1e9
        } $DESO`
      );
      return;
    }

    const titleSlug = stringToSlug(this.model.Title);
    const existingSlugMappings = JSON.parse(currentUserProfile.ExtraData?.BlogSlugMap ?? "{}");

    // check that there is not a collision with a previous article slug
    if (
      Object.entries(existingSlugMappings).some(
        ([slug, postHashHex]) => titleSlug === slug && postHashHex !== this.editPostHashHex
      )
    ) {
      this.globalVars._alertError(
        "This post has a title that conflicts with one of your previous posts! Please give your post a different title."
      );
      return;
    }

    this.model.validate();

    if (this.model.hasErrors) {
      this.globalVars._alertError(this.model.errors[0]);
      return;
    }

    this.isSubmittingPost = true;

    try {
      this.model.ContentDelta = await this.postProcessDelta(this.model.ContentDelta);

      const twitter = require("../../../vendor/twitter-text-3.1.0.js");
      const entities = Array.from(
        new Set(
          twitter
            .extractEntitiesWithIndices(this.contentAsPlainText, {
              extractUrlsWithoutProtocol: false,
            })
            .filter((entity: any) => entity.screenName || entity.cashtag || entity.hashtag)
            .map((entity: any) => {
              if (entity.screenName) {
                return `@${entity.screenName}`;
              }
              if (entity.cashtag) {
                return `$${entity.cashtag}`;
              }
              if (entity.hashtag) {
                return `#${entity.hashtag}`;
              }
            })
        )
      )
        .sort()
        .reverse()
        .join(" ");

      let postExtraData: BlogPostExtraData = {
        Title: this.model.Title.trim(),
        Description: this.model.Description.trim(),
        BlogDeltaRtfFormat: JSON.stringify(this.model.ContentDelta),
        BlogTitleSlug: titleSlug,
        CoverImage: (this.coverImageFile && (await this.uploadImage(this.coverImageFile))) ?? this.model.CoverImage,
      };

      if (environment.node.id) {
        postExtraData.Node = environment.node.id.toString();
      }

      if (this.translocoService.getActiveLang()) {
        postExtraData.Language = this.translocoService.getActiveLang();
      }

      const permalink = `${window.location.origin}/u/${currentUserProfile.Username}/blog/${titleSlug}`;
      const postTx = await this.backendApi
        .SubmitPost(
          this.globalVars.localNode,
          this.globalVars.loggedInUser.PublicKeyBase58Check,
          this.editPostHashHex ?? "" /*PostHashHexToModify*/,
          "" /*ParentPostHashHex*/,
          "" /*Title*/,
          {
            Body: `${postExtraData.Title}\n\n${postExtraData.Description}\n\nView this post at ${permalink}${
              entities ? `\n\nMentions: ${entities}` : ""
            }\n\n#blog`,
            ImageURLs: postExtraData.CoverImage ? [postExtraData.CoverImage] : [],
          } /*BodyObj*/,
          "" /*RepostedPostHashHex*/,
          postExtraData /*PostExtraData*/,
          "" /*Sub*/,
          false /*IsHidden*/,
          this.globalVars.defaultFeeRateNanosPerKB /*MinFeeRateNanosPerKB*/,
          false
        )
        .toPromise();
      const submittedPostHashHex = postTx.PostEntryResponse.PostHashHex;

      // if this is a new post, or the author updates the title of an existing
      // post, update the user's profile with a mapping from postHashHex to url
      // slug
      if (!this.editPostHashHex || !existingSlugMappings[titleSlug]) {
        // first, wait for the submitPost tx to show up to prevent any utxo double spend errors.
        await this.globalVars.waitForTransaction(postTx.TxnHashHex);

        const blogSlugMapJSON = JSON.stringify({
          ...existingSlugMappings,
          [titleSlug]: submittedPostHashHex,
        });

        await this.backendApi
          .UpdateProfile(
            this.globalVars.localNode,
            this.globalVars.localNode,
            this.globalVars.loggedInUser.PublicKeyBase58Check,
            "",
            "",
            "",
            "",
            this.globalVars?.loggedInUser?.ProfileEntryResponse?.CoinEntry?.CreatorBasisPoints || 100 * 100,
            1.25 * 100 * 100,
            false,
            this.globalVars.feeRateDeSoPerKB * 1e9,
            { BlogSlugMap: blogSlugMapJSON }
          )
          .toPromise();
        currentUserProfile.ExtraData.BlogSlugMap = blogSlugMapJSON;
      }

      this.toastr.show(
        `Blog Post Created<a href="${permalink}" class="toast-link cursor-pointer">View</a>`,
        undefined,
        {
          toastClass: "info-toast",
          enableHtml: true,
          positionClass: "toast-bottom-center",
        }
      );
    } catch (e) {
      this.globalVars._alertError(
        `Whoops, something went wrong...${e?.error?.error ? JSON.stringify(e.error.error) : e.toString()}`
      );
    }

    this.isSubmittingPost = false;
  }

  onFormInput(ev: Event) {
    ev.preventDefault();
    this.model.clearErrors();
  }

  /**
   * @returns the uploaded image url. empty string if the file invalid.
   */
  async uploadImage(file: File): Promise<string> {
    if (file.size > 15 * (1024 * 1024)) {
      this.globalVars._alertError("File is too large. Please choose a file less than 15MB");
      return "";
    }

    return this.backendApi
      .UploadImage(environment.uploadImageHostname, this.globalVars.loggedInUser.PublicKeyBase58Check, file)
      .toPromise()
      .then((res) => res.ImageURL)
      .catch((err) => {
        this.globalVars._alertError(JSON.stringify(err.error.error));
        return "";
      });
  }

  onDragOver(ev: DragEvent) {
    ev.preventDefault();
    this.isDraggingFileOverDropZone = true;
  }

  onDragEnter(ev: DragEvent) {
    ev.preventDefault();
    this.isDraggingFileOverDropZone = true;
  }

  onDragLeave(ev: DragEvent) {
    ev.preventDefault();
    this.isDraggingFileOverDropZone = false;
  }

  onClickSelectFile(ev: DragEvent) {
    ev.preventDefault();
    if (!this.coverImgInput?.nativeElement) {
      this.globalVars._alertError("Whoops, something went wrong. Unable to select files.");
      return;
    }

    this.coverImgInput.nativeElement.click();
  }

  onDropImg(ev: DragEvent) {
    ev.preventDefault();
    this.isDraggingFileOverDropZone = false;
    const file = ev?.dataTransfer?.files?.[0];
    if (!file) {
      this.globalVars._alertError(
        "No files were detected. Please try it again. If the error continues, try another file."
      );
      return;
    }

    this.handleCoverImgFileChange(file);
  }

  onFileSelected(ev: Event) {
    ev.preventDefault();
    const file = (ev.currentTarget as HTMLInputElement)?.files?.[0];

    if (!file) {
      this.globalVars._alertError(
        "No files were detected. Please try it again. If the error continues, try another file."
      );
      return;
    }

    this.handleCoverImgFileChange(file);
  }

  async handleCoverImgFileChange(file: File) {
    if (file.size > 15 * (1024 * 1024)) {
      this.globalVars._alertError("File is too large. Please choose a file less than 15MB");
      return "";
    }
    this.imagePreviewDataURL = await fileToDataURL(file);
    this.coverImageFile = file;
  }

  onRemoveCoverImg(ev: Event) {
    ev.preventDefault();
    this.imagePreviewDataURL = undefined;
    this.coverImageFile = undefined;
    this.model.CoverImage = "";
  }
}

// Naively copied this from here:
// https://gist.github.com/codeguy/6684588?permalink_comment_id=3332719#gistcomment-3332719
// Tested with a few edge cases (special chars, weird spacing, etc) and it did
// fine. May need to revisit if it doesn't handle some edge case properly.
const stringToSlug = (str: string) =>
  str
    .normalize("NFD") // split an accented letter in the base letter and the acent
    .replace(/[\u0300-\u036f]/g, "") // remove all previously split accents
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "") // remove all chars not letters, numbers and spaces (to be replaced)
    .trim()
    .replace(/\s+/g, "-") // replace all spaces with -
    .replace(/-+/g, "-"); // replace multiple - with a single -
