module Gtd.Support exposing
    ( ExternalLink
    , File
    , Folder
    , Kind(..)
    , LinkedFile
    , Material
    , Msg
    , Request(..)
    , State
    , count
    , gotNoteBody
    , init
    , isEmpty
    , materialDecoder
    , noteCreated
    , update
    , view
    )

{-| A Project's Support Material: the files in its support folder, the vault files it
links, and the web pages it refers to. The Project page's Support tab and the running
Pomodoro both show it through this module, so the two stay alike.

A surface keeps a `State` per Project, maps `Msg` into its own messages, and turns each
`Request` into its host command for that Project. Host replies come back through
`gotNoteBody` and `noteCreated`.

-}

import Dict exposing (Dict)
import Gtd.Ui as Ui
import Html exposing (Html, article, button, div, h3, header, img, input, node, section, span, text, textarea)
import Html.Attributes exposing (alt, attribute, class, classList, disabled, placeholder, src, type_, value)
import Html.Events exposing (onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Set exposing (Set)


{-| What a support file is, and therefore how it is presented.
-}
type Kind
    = Note
    | Image
    | Attachment


type alias File =
    { path : String, label : String, kind : Kind, resourceUrl : String }


type alias Folder =
    { path : String, label : String }


{-| A vault file the Project links to without owning it. `path` is empty when the
link no longer resolves to a file.
-}
type alias LinkedFile =
    { link : String, path : String, label : String }


{-| A web link the Project refers to. `entry` is how it is written in the Project
note, which identifies it for removal.
-}
type alias ExternalLink =
    { entry : String, url : String, title : String }


type alias Material =
    { projectId : String
    , files : List File
    , folders : List Folder
    , linkedFiles : List LinkedFile
    , externalLinks : List ExternalLink
    }


{-| Notes unfolded, the note being edited and its draft, the bodies read so far, and the
inputs for a new note, folder and link.
-}
type alias State =
    { open : Set String
    , editing : Maybe String
    , bodies : Dict String String
    , draft : String
    , noteTitle : String
    , folderPath : String
    , linkUrl : String
    , linkTitle : String
    }


init : State
init =
    { open = Set.empty
    , editing = Nothing
    , bodies = Dict.empty
    , draft = ""
    , noteTitle = ""
    , folderPath = ""
    , linkUrl = ""
    , linkTitle = ""
    }


type Msg
    = Toggle File
    | BeginEdit File
    | DraftChanged String
    | CancelEdit
    | Save String
    | NoteTitleChanged String
    | CreateNote
    | FolderPathChanged String
    | CreateFolder
    | LinkUrlChanged String
    | LinkTitleChanged String
    | AddLink
    | Ask Request
    | NoOp


{-| What the host should do for the Project. `ReadNote` answers with the note's body
(`gotNoteBody`) and `CreateNote` with the new note's path (`noteCreated`).
-}
type Request
    = OpenFile String
    | OpenUrl String
    | ReadNote String
    | SaveNote String String
    | CreateNoteNamed String
    | CreateFolderAt String
    | LinkFile
    | UnlinkFile String
    | AddLinkTo String String
    | RemoveLink String


update : Msg -> State -> ( State, Maybe Request )
update msg state =
    case msg of
        Toggle file ->
            let
                open =
                    if Set.member file.path state.open then
                        Set.remove file.path state.open

                    else
                        Set.insert file.path state.open

                next =
                    { state | open = open }
            in
            if Set.member file.path open && file.kind == Note && not (Dict.member file.path state.bodies) then
                ( next, Just (ReadNote file.path) )

            else
                ( next, Nothing )

        BeginEdit file ->
            let
                next =
                    { state | open = Set.insert file.path state.open, editing = Just file.path }
            in
            case Dict.get file.path state.bodies of
                Just body ->
                    ( { next | draft = body }, Nothing )

                Nothing ->
                    ( next, Just (ReadNote file.path) )

        DraftChanged body ->
            ( { state | draft = body }, Nothing )

        CancelEdit ->
            ( { state | editing = Nothing }, Nothing )

        Save path ->
            ( { state | bodies = Dict.insert path state.draft state.bodies, editing = Nothing }
            , Just (SaveNote path state.draft)
            )

        NoteTitleChanged title ->
            ( { state | noteTitle = title }, Nothing )

        CreateNote ->
            if String.isEmpty (String.trim state.noteTitle) then
                ( state, Nothing )

            else
                ( state, Just (CreateNoteNamed (String.trim state.noteTitle)) )

        FolderPathChanged path ->
            ( { state | folderPath = path }, Nothing )

        CreateFolder ->
            if String.isEmpty (String.trim state.folderPath) then
                ( state, Nothing )

            else
                ( { state | folderPath = "" }, Just (CreateFolderAt (String.trim state.folderPath)) )

        LinkUrlChanged url ->
            ( { state | linkUrl = url }, Nothing )

        LinkTitleChanged title ->
            ( { state | linkTitle = title }, Nothing )

        AddLink ->
            if String.isEmpty (String.trim state.linkUrl) then
                ( state, Nothing )

            else
                ( { state | linkUrl = "", linkTitle = "" }
                , Just (AddLinkTo (String.trim state.linkUrl) (String.trim state.linkTitle))
                )

        Ask request ->
            ( state, Just request )

        NoOp ->
            ( state, Nothing )


{-| A note's body, read by the host. A note being edited starts its draft from it.
-}
gotNoteBody : String -> String -> State -> State
gotNoteBody path body state =
    { state
        | bodies = Dict.insert path body state.bodies
        , draft =
            if state.editing == Just path then
                body

            else
                state.draft
    }


{-| A note was created: it opens for editing, and its body is read.
-}
noteCreated : String -> State -> ( State, Request )
noteCreated path state =
    ( { state | noteTitle = "", open = Set.insert path state.open, editing = Just path }, ReadNote path )


{-| How many pieces of material there are, for a heading or a tab.
-}
count : Material -> Int
count material =
    List.length material.files + List.length material.linkedFiles + List.length material.externalLinks


isEmpty : Material -> Bool
isEmpty material =
    count material == 0 && List.isEmpty material.folders



-- VIEW


{-| The support folder, the linked files and the web links, with ways to add to them.
-}
view : Maybe String -> Material -> State -> List (Html Msg)
view supportPath material state =
    [ viewFolder supportPath material state
    , viewLinkedFiles material
    , viewExternalLinks material state
    ]


viewFolder : Maybe String -> Material -> State -> Html Msg
viewFolder supportPath material state =
    let
        readable =
            List.filter (\file -> file.kind /= Attachment) material.files

        attachments =
            List.filter (\file -> file.kind == Attachment) material.files
    in
    section [ class "dg-detail-section dg-support-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ div []
                [ h3 [ class "dg-detail-eyebrow" ] [ text "Support folder" ]
                , Ui.maybeView supportPath (\path -> div [ class "dg-support-path" ] [ text path ])
                ]
            , span [ class "dg-detail-count" ]
                [ text (String.fromInt (List.length material.files) ++ " files · " ++ String.fromInt (List.length material.folders) ++ " folders") ]
            ]
        , div [ class "dg-support-create" ]
            [ div [ class "dg-support-note-create" ]
                [ Ui.labelled "New note title" (input [ value state.noteTitle, placeholder "Note title…", onInput NoteTitleChanged, Ui.onEnter { enter = CreateNote, ignore = NoOp } ] [])
                , button [ class "mod-cta", disabled (String.isEmpty (String.trim state.noteTitle)), onClick CreateNote ] [ text "Create note" ]
                ]
            , div [ class "dg-support-folder-create" ]
                [ Ui.labelled "New folder" (input [ value state.folderPath, placeholder "Folder name or path…", onInput FolderPathChanged, Ui.onEnter { enter = CreateFolder, ignore = NoOp } ] [])
                , button [ disabled (String.isEmpty (String.trim state.folderPath)), onClick CreateFolder ] [ text "Create folder" ]
                ]
            ]
        , if List.isEmpty material.folders then
            text ""

          else
            div [ class "dg-support-folders" ]
                [ span [] [ text "Folders" ]
                , div [] (List.map (\folder -> span [] [ text ("📁 " ++ folder.label) ]) material.folders)
                ]
        , div [ class "dg-support-notes" ] (List.map (viewFile state) readable)
        , if List.isEmpty attachments then
            text ""

          else
            div [ class "dg-support-attachments" ]
                [ span [] [ text "Other files" ]
                , div []
                    (List.map
                        (\file -> button [ class "dg-flat-button", onClick (Ask (OpenFile file.path)) ] [ text file.label ])
                        attachments
                    )
                ]
        , if List.isEmpty material.files && List.isEmpty material.folders then
            span [ class "dg-support-empty" ] [ text "No support material yet." ]

          else
            text ""
        ]


{-| Files elsewhere in the vault that the Project refers to. They are only linked,
so deleting the Project leaves them where they are.
-}
viewLinkedFiles : Material -> Html Msg
viewLinkedFiles material =
    section [ class "dg-detail-section dg-linked-files-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ h3 [ class "dg-detail-eyebrow" ] [ text "Linked files" ]
            , div [ class "dg-detail-section-actions" ]
                [ span [ class "dg-detail-count" ] [ text (String.fromInt (List.length material.linkedFiles)) ]
                , button [ onClick (Ask LinkFile) ] [ text "Link file…" ]
                ]
            ]
        , if List.isEmpty material.linkedFiles then
            span [ class "dg-support-empty" ] [ text "No linked files. Linked files stay where they are, even if this Project is deleted." ]

          else
            div [ class "dg-linked-files" ]
                (List.map
                    (\file ->
                        div [ class "dg-linked-file" ]
                            [ if String.isEmpty file.path then
                                span [ class "dg-missing" ] [ text ("⚠ Missing: " ++ file.label) ]

                              else
                                button [ class "dg-linked-file-open dg-flat-button", onClick (Ask (OpenFile file.path)) ]
                                    [ span [ class "dg-link-icon", attribute "aria-hidden" "true" ] [ text "📄" ]
                                    , span [ class "dg-linked-file-label" ] [ text file.label ]
                                    ]
                            , button
                                [ class "dg-linked-file-unlink dg-flat-button"
                                , onClick (Ask (UnlinkFile file.link))
                                ]
                                (Ui.iconLabel "Unlink" ("Unlink " ++ file.label))
                            ]
                    )
                    material.linkedFiles
                )
        ]


{-| Web pages the Project refers to. Only http and https links are kept.
-}
viewExternalLinks : Material -> State -> Html Msg
viewExternalLinks material state =
    section [ class "dg-detail-section dg-external-links-panel" ]
        [ div [ class "dg-detail-section-heading" ]
            [ h3 [ class "dg-detail-eyebrow" ] [ text "External links" ]
            , span [ class "dg-detail-count" ] [ text (String.fromInt (List.length material.externalLinks)) ]
            ]
        , div [ class "dg-external-link-add" ]
            [ Ui.labelled "Web address"
                (input
                    [ type_ "url"
                    , value state.linkUrl
                    , placeholder "https://…"
                    , onInput LinkUrlChanged
                    , Ui.onEnter { enter = AddLink, ignore = NoOp }
                    ]
                    []
                )
            , Ui.labelled "Link title"
                (input
                    [ value state.linkTitle
                    , placeholder "Title (optional)"
                    , onInput LinkTitleChanged
                    , Ui.onEnter { enter = AddLink, ignore = NoOp }
                    ]
                    []
                )
            , button [ disabled (String.isEmpty (String.trim state.linkUrl)), onClick AddLink ] [ text "Add link" ]
            ]
        , if List.isEmpty material.externalLinks then
            span [ class "dg-support-empty" ] [ text "No external links." ]

          else
            div [ class "dg-linked-files" ]
                (List.map
                    (\link ->
                        div [ class "dg-linked-file" ]
                            [ button [ class "dg-linked-file-open dg-flat-button", onClick (Ask (OpenUrl link.url)) ]
                                [ span [ class "dg-link-icon", attribute "aria-hidden" "true" ] [ text "🌐" ]
                                , span [ class "dg-linked-file-label" ] [ text link.title ]
                                , span [ class "dg-link-icon", attribute "aria-hidden" "true" ] [ text "↗" ]
                                , if link.title /= link.url then
                                    span [ class "dg-external-link-host" ] [ text (host link.url) ]

                                  else
                                    text ""
                                ]
                            , button
                                [ class "dg-linked-file-unlink dg-flat-button"
                                , onClick (Ask (RemoveLink link.entry))
                                ]
                                (Ui.iconLabel "Remove" ("Remove link " ++ link.title))
                            ]
                    )
                    material.externalLinks
                )
        ]


{-| The host part of a web address, shown next to a titled link.
-}
host : String -> String
host url =
    url
        |> String.split "://"
        |> List.drop 1
        |> List.head
        |> Maybe.withDefault url
        |> String.split "/"
        |> List.head
        |> Maybe.withDefault url


viewFile : State -> File -> Html Msg
viewFile state file =
    let
        open =
            Set.member file.path state.open

        editing =
            state.editing == Just file.path
    in
    article [ classList [ ( "dg-support-note", True ), ( "dg-support-image", file.kind == Image ), ( "is-open", open ) ] ]
        [ header []
            [ button
                [ class "dg-support-note-toggle dg-flat-button"
                , onClick (Toggle file)
                , attribute "aria-expanded" (Ui.boolAttribute open)
                ]
                [ span []
                    [ text
                        (if open then
                            "▾"

                         else
                            "▸"
                        )
                    ]
                , span [] [ text file.label ]
                ]
            , div []
                (button [ class "dg-flat-button", onClick (Ask (OpenFile file.path)) ] [ text "Open" ]
                    :: (if file.kind == Note then
                            [ button [ class "dg-flat-button", onClick (BeginEdit file) ] [ text "Edit" ] ]

                        else
                            []
                       )
                )
            ]
        , if not open then
            text ""

          else
            div
                [ class
                    (if file.kind == Image then
                        "dg-support-note-body dg-support-image-body"

                     else
                        "dg-support-note-body"
                    )
                ]
                [ viewBody state file editing ]
        ]


viewBody : State -> File -> Bool -> Html Msg
viewBody state file editing =
    if file.kind == Image then
        img [ src file.resourceUrl, alt file.label ] []

    else if editing then
        div []
            [ Ui.labelled ("Text of " ++ file.label)
                (textarea
                    [ value state.draft
                    , onInput DraftChanged
                    , Ui.onModEnter (Save file.path)
                    ]
                    []
                )
            , div [ class "dg-support-note-edit-actions" ]
                [ button [ onClick CancelEdit ] [ text "Cancel" ]
                , button [ class "mod-cta", onClick (Save file.path) ] [ text "Save note" ]
                ]
            ]

    else
        case Dict.get file.path state.bodies of
            Just content ->
                if String.isEmpty content then
                    span [ class "dg-muted" ] [ text "This note is empty." ]

                else
                    node "dg-markdown"
                        [ class "dg-outcome markdown-rendered"
                        , attribute "data-markdown" content
                        , attribute "data-source-path" file.path
                        ]
                        []

            Nothing ->
                span [ class "dg-muted" ] [ text "Loading…" ]



-- DECODERS


{-| Reads the material out of the host's Project detail (`ElmProjectDetailDto`).
-}
materialDecoder : Decoder Material
materialDecoder =
    Decode.map5 Material
        (Decode.field "projectId" Decode.string)
        (Decode.field "supportFiles" (Decode.list fileDecoder))
        (Decode.field "supportFolders" (Decode.list (Decode.map2 Folder (Decode.field "path" Decode.string) (Decode.field "label" Decode.string))))
        (Decode.field "linkedFiles"
            (Decode.list
                (Decode.map3 LinkedFile
                    (Decode.field "link" Decode.string)
                    (Decode.field "path" Decode.string)
                    (Decode.field "label" Decode.string)
                )
            )
        )
        (Decode.field "externalLinks"
            (Decode.list
                (Decode.map3 ExternalLink
                    (Decode.field "entry" Decode.string)
                    (Decode.field "url" Decode.string)
                    (Decode.field "title" Decode.string)
                )
            )
        )


fileDecoder : Decoder File
fileDecoder =
    Decode.map4 File
        (Decode.field "path" Decode.string)
        (Decode.field "label" Decode.string)
        (Decode.field "kind" kindDecoder)
        (Decode.field "resourceUrl" Decode.string)


kindDecoder : Decoder Kind
kindDecoder =
    Decode.string
        |> Decode.andThen
            (\raw ->
                case raw of
                    "note" ->
                        Decode.succeed Note

                    "image" ->
                        Decode.succeed Image

                    "attachment" ->
                        Decode.succeed Attachment

                    _ ->
                        Decode.fail ("Unknown support file kind: " ++ raw)
            )
