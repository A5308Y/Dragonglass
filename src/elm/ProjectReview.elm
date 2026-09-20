port module ProjectReview exposing (main)

import Browser
import Dict exposing (Dict)
import Html exposing (Html, button, datalist, div, h2, h3, header, input, label, option, p, section, span, strong, text, textarea)
import Html.Attributes exposing (attribute, checked, class, classList, disabled, id, list, placeholder, style, title, type_, value)
import Html.Events exposing (on, onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
import Time


port reviewToHost : Encode.Value -> Cmd msg


port reviewFromHost : (Decode.Value -> msg) -> Sub msg


protocolVersion : Int
protocolVersion =
    1


type alias File =
    { path : String }


type alias Action =
    { id : String
    , title : String
    , file : File
    , status : String
    , projectId : Maybe String
    , context : Maybe String
    , due : Maybe String
    }


type alias Project =
    { id : String
    , title : String
    , file : File
    , status : String
    , area : Maybe String
    , reviewed : Maybe String
    , parentProjectId : Maybe String
    }


type alias Snapshot =
    { revision : Int, today : String, actions : List Action, projects : List Project }


type alias DiaryEntry =
    { timestamp : String, body : String }


type alias ReviewData =
    { projectId : String, desiredOutcome : String, diary : List DiaryEntry }


type alias SupportCount =
    { projectId : String, count : Int }


type Pending
    = Ignore
    | Advance String
    | DeleteAndAdvance String
    | AddDiary
    | AddAction


type alias Model =
    { snapshot : Snapshot
    , queue : List String
    , total : Int
    , supportCounts : Dict String Int
    , reviewData : Maybe ReviewData
    , desiredOutcome : String
    , diaryInput : String
    , actionTitle : String
    , actionProjectId : String
    , actionProjectQuery : String
    , context : String
    , work : Bool
    , sessionSeconds : Int
    , projectSeconds : Int
    , nextRequest : Int
    , pending : Dict String Pending
    , saving : Bool
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | Tick Time.Posix
    | OutcomeChanged String
    | DiaryChanged String
    | AddDiaryText String
    | ActionTitleChanged String
    | ActionProjectChanged String
    | ContextChanged String
    | WorkChanged Bool
    | AddActionNow
    | CompleteReview
    | MoveToSomeday
    | DeleteProject
    | HostCommand Pending Encode.Value
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> Sub.batch [ reviewFromHost GotHost, Time.every 1000 Tick ]
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok decoded ->
            let
                model =
                    { snapshot = decoded.snapshot
                    , queue = decoded.queue
                    , total = List.length decoded.queue
                    , supportCounts = Dict.fromList (List.map (\item -> ( item.projectId, item.count )) decoded.supportCounts)
                    , reviewData = Nothing
                    , desiredOutcome = ""
                    , diaryInput = ""
                    , actionTitle = ""
                    , actionProjectId = ""
                    , actionProjectQuery = ""
                    , context = ""
                    , work = False
                    , sessionSeconds = 0
                    , projectSeconds = budget (List.length decoded.queue)
                    , nextRequest = 1
                    , pending = Dict.empty
                    , saving = False
                    , error = Nothing
                    }
            in
            loadCurrent (resetProjectForm model)

        Err error ->
            ( emptyModel (Decode.errorToString error), Cmd.none )


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value_ ->
            receiveHost value_ model

        Tick _ ->
            ( { model | sessionSeconds = model.sessionSeconds + 1, projectSeconds = model.projectSeconds - 1 }, Cmd.none )

        OutcomeChanged outcome ->
            ( { model | desiredOutcome = outcome }, Cmd.none )

        DiaryChanged entry ->
            ( { model | diaryInput = entry }, Cmd.none )

        AddDiaryText entry ->
            case currentProject model of
                Just project ->
                    if String.isEmpty (String.trim entry) then
                        ( model, Cmd.none )

                    else
                        send AddDiary (bodyCommand "add-diary-entry" project.id entry) model

                Nothing ->
                    ( model, Cmd.none )

        ActionTitleChanged title_ ->
            ( { model | actionTitle = title_ }, Cmd.none )

        ActionProjectChanged query ->
            let
                projectId =
                    reviewMembers model
                        |> List.filter (\project -> projectLabel model project == query)
                        |> List.head
                        |> Maybe.map .id
                        |> Maybe.withDefault ""
            in
            ( { model | actionProjectQuery = query, actionProjectId = projectId }, Cmd.none )

        ContextChanged context ->
            ( { model | context = context }, Cmd.none )

        WorkChanged work ->
            ( { model | work = work }, Cmd.none )

        AddActionNow ->
            if String.isEmpty (String.trim model.actionTitle) || String.isEmpty model.actionProjectId || String.isEmpty (String.trim model.context) then
                ( model, Cmd.none )

            else
                send AddAction (createActionCommand model) { model | saving = True }

        CompleteReview ->
            case currentProject model of
                Just project ->
                    if List.isEmpty (blockingProjects model) then
                        send (Advance project.id) (reviewCommand "complete-project-review" project.id model) { model | saving = True }

                    else
                        ( { model | error = Just "Add a Next Action or move this Project to Someday/Maybe before continuing." }, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        MoveToSomeday ->
            case currentProject model of
                Just project ->
                    send (Advance project.id) (reviewCommand "move-review-to-someday" project.id model) { model | saving = True }

                Nothing ->
                    ( model, Cmd.none )

        DeleteProject ->
            case currentProject model of
                Just project ->
                    send (DeleteAndAdvance project.id) (projectCommand "trash-project" project.id) { model | saving = True }

                Nothing ->
                    ( model, Cmd.none )

        HostCommand pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


type HostEvent
    = SnapshotEvent Snapshot
    | ReviewDataEvent ReviewData
    | CommandResult String Bool (Maybe String) Decode.Value


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value_ model =
    case Decode.decodeValue hostEventDecoder value_ of
        Err _ ->
            ( model, Cmd.none )

        Ok event ->
            case event of
                SnapshotEvent snapshot ->
                    let
                        ids =
                            Set.fromList (List.map .id snapshot.projects)

                        nextQueue =
                            List.filter (\id_ -> Set.member id_ ids) model.queue
                    in
                    ( { model | snapshot = snapshot, queue = nextQueue }, Cmd.none )

                ReviewDataEvent data ->
                    if List.head model.queue == Just data.projectId then
                        ( { model | reviewData = Just data, desiredOutcome = data.desiredOutcome }, Cmd.none )

                    else
                        ( model, Cmd.none )

                CommandResult requestId ok errorMessage resultValue ->
                    if requestId == "review-support-counts" then
                        case Decode.decodeValue (Decode.list supportCountDecoder) resultValue of
                            Ok counts ->
                                ( { model | supportCounts = Dict.fromList (List.map (\item -> ( item.projectId, item.count )) counts) }, Cmd.none )

                            Err _ ->
                                ( model, Cmd.none )

                    else
                        let
                            operation =
                                Dict.get requestId model.pending |> Maybe.withDefault Ignore

                            next =
                                { model
                                    | pending = Dict.remove requestId model.pending
                                    , saving = False
                                    , error =
                                        if ok then
                                            Nothing

                                        else
                                            errorMessage
                                }
                        in
                        if not ok then
                            ( next, Cmd.none )

                        else
                            finish operation resultValue next


finish : Pending -> Decode.Value -> Model -> ( Model, Cmd Msg )
finish pending value_ model =
    case pending of
        Advance projectId ->
            advance projectId model

        DeleteAndAdvance projectId ->
            case Decode.decodeValue Decode.bool value_ of
                Ok True ->
                    advance projectId model

                _ ->
                    ( model, Cmd.none )

        AddDiary ->
            case Decode.decodeValue diaryDecoder value_ of
                Ok entry ->
                    let
                        data =
                            Maybe.map (\current -> { current | diary = entry :: current.diary }) model.reviewData
                    in
                    ( { model | reviewData = data, diaryInput = "" }, Cmd.none )

                Err _ ->
                    ( model, Cmd.none )

        AddAction ->
            ( { model | actionTitle = "", context = "" }, Cmd.none )

        Ignore ->
            ( model, Cmd.none )


advance : String -> Model -> ( Model, Cmd Msg )
advance projectId model =
    let
        next =
            resetProjectForm { model | queue = List.filter ((/=) projectId) model.queue, projectSeconds = budget model.total }
    in
    loadCurrent next


resetProjectForm : Model -> Model
resetProjectForm model =
    let
        default =
            List.head (blockingProjects model)
                |> Maybe.withDefault (List.head (missingNextProjects model) |> Maybe.withDefault (currentProject model |> Maybe.withDefault emptyProject))
    in
    { model
        | reviewData = Nothing
        , desiredOutcome = ""
        , diaryInput = ""
        , actionTitle = ""
        , actionProjectId =
            if default.id == "" then
                ""

            else
                default.id
        , actionProjectQuery =
            if default.id == "" then
                ""

            else
                projectLabel model default
        , context = ""
        , work = False
        , error = Nothing
    }


loadCurrent : Model -> ( Model, Cmd Msg )
loadCurrent model =
    case currentProject model of
        Just project ->
            send Ignore (projectCommand "load-review-project" project.id) (resetProjectForm model)

        Nothing ->
            ( model, Cmd.none )


send : Pending -> Encode.Value -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        requestId =
            "review-" ++ String.fromInt model.nextRequest
    in
    ( { model | nextRequest = model.nextRequest + 1, pending = Dict.insert requestId pending model.pending }
    , reviewToHost (Encode.object [ ( "protocolVersion", Encode.int protocolVersion ), ( "requestId", Encode.string requestId ), ( "command", command ) ])
    )


view : Model -> Html Msg
view model =
    case currentProject model of
        Nothing ->
            div [ class "dg-view dg-review-view" ]
                [ header [ class "dg-view-header" ] [ div [] [ h2 [] [ text "Project Review" ] ] ]
                , div [ class "dg-workflow-complete" ]
                    [ span [] [ text "✅" ]
                    , h3 [] [ text "Review complete" ]
                    , p []
                        [ text
                            (if model.total > 0 then
                                "All " ++ String.fromInt model.total ++ " Project trees were reviewed."

                             else
                                "No Projects need review today."
                            )
                        ]
                    ]
                ]

        Just project ->
            viewProject model project


viewProject : Model -> Project -> Html Msg
viewProject model project =
    let
        members =
            reviewMembers model

        subprojects =
            List.filter (\item -> item.id /= project.id) members

        actions =
            reviewActions model

        openActions =
            List.filter (\action -> not (List.member action.status [ "done", "cancelled" ])) actions

        nextActions =
            List.filter (\action -> action.status == "next") openActions

        doneActions =
            List.filter (\action -> action.status == "done") actions

        blockers =
            blockingProjects model

        supportFiles =
            members |> List.map (\item -> Dict.get item.id model.supportCounts |> Maybe.withDefault 0) |> List.sum

        progress =
            if model.total == 0 then
                100

            else
                toFloat (model.total - List.length model.queue) / toFloat model.total * 100
    in
    div [ class "dg-view dg-review-view" ]
        [ header [ class "dg-view-header dg-review-header" ]
            [ div [ class "dg-review-title" ] [ span [ class "dg-review-eyebrow" ] [ text "Guided workflow" ], h2 [] [ text "Project Review" ] ]
            , div [ class "dg-review-timers" ]
                [ div [] [ span [] [ text "Session" ], strong [] [ text (formatTimer model.sessionSeconds) ] ]
                , div [ classList [ ( "is-overdue", model.projectSeconds <= 30 ) ] ] [ span [] [ text "Project budget" ], strong [] [ text (formatTimer model.projectSeconds) ] ]
                ]
            ]
        , div [ class "dg-progress-track" ] [ span [ style "width" (String.fromFloat progress ++ "%") ] [] ]
        , maybeError model.error
        , div [ class "dg-review-content" ]
            [ section [ class "dg-review-hero" ]
                [ div [ class "dg-review-hero-copy" ]
                    [ span [ class "dg-review-eyebrow" ] [ text ("Project tree " ++ String.fromInt (model.total - List.length model.queue + 1) ++ " of " ++ String.fromInt model.total) ]
                    , button [ class "dg-project-title", onClick (HostCommand Ignore (openFileCommand project.file.path)) ] [ text project.title ]
                    , div [ class "dg-review-project-meta" ]
                        [ span [ class "dg-status" ] [ text (Maybe.withDefault (statusLabel project.status) project.area) ]
                        , span [] [ text (plural (List.length members) "Project") ]
                        , span [] [ text (String.fromInt (List.length openActions) ++ " open") ]
                        , span [] [ text (String.fromInt (List.length nextActions) ++ " next") ]
                        ]
                    ]
                , if List.isEmpty blockers then
                    text ""

                  else
                    span [ class "dg-no-next" ] [ text (String.fromInt (List.length blockers) ++ " without Next Action") ]
                ]
            , viewTree model project subprojects actions
            , section [ class "dg-review-grid" ] [ viewOutcome model, viewPulse model project ]
            , viewActions model openActions
            , section [ class "dg-review-grid" ] [ viewDiary model, viewStats doneActions supportFiles ]
            , viewFooter model project blockers
            ]
        ]


viewTree : Model -> Project -> List Project -> List Action -> Html Msg
viewTree model root subprojects actions =
    section [ class "dg-review-panel dg-review-tree-panel" ]
        [ div [ class "dg-review-panel-heading dg-review-panel-heading-row" ]
            [ span [ class "dg-review-panel-icon" ] [ text "⌘" ]
            , div [] [ h3 [] [ text "Project tree" ], p [] [ text "Reviewed together as one outcome hierarchy." ] ]
            , span [ class "dg-review-count" ] [ text (String.fromInt (List.length subprojects)) ]
            , button [ class "dg-review-tree-add", onClick (HostCommand Ignore (createProjectCommand root.id)) ] [ text "New sub-project" ]
            ]
        , if List.isEmpty subprojects then
            div [ class "dg-review-tree-empty" ] [ text "No sub-projects yet." ]

          else
            div [ class "dg-review-tree-list" ]
                (List.map
                    (\project ->
                        let
                            projectActions =
                                List.filter (\action -> action.projectId == Just project.id && not (List.member action.status [ "done", "cancelled" ])) actions

                            nextCount =
                                List.filter (\action -> action.status == "next") projectActions |> List.length
                        in
                        div []
                            [ button [ title (projectBreadcrumb model.snapshot.projects project), onClick (HostCommand Ignore (openFileCommand project.file.path)) ] [ text (relativeLabel model root project) ]
                            , span [] [ text (statusLabel project.status) ]
                            , span [] [ text (String.fromInt (List.length projectActions) ++ " open · " ++ String.fromInt nextCount ++ " next") ]
                            , if project.status == "active" && nextCount == 0 then
                                strong [] [ text "No Next Action" ]

                              else
                                text ""
                            ]
                    )
                    subprojects
                )
        ]


viewOutcome : Model -> Html Msg
viewOutcome model =
    div [ class "dg-review-panel dg-review-outcome-panel" ]
        [ panelHeading "◎" "Desired outcome" "Reconnect with what done looks like."
        , textarea [ value model.desiredOutcome, placeholder "What will be true when this Project is complete?", onInput OutcomeChanged ] []
        ]


viewPulse : Model -> Project -> Html Msg
viewPulse model project =
    let
        emojis =
            [ ( "👍", "no progress, but looks good" ), ( "🌱", "slow progress" ), ( "🛠️", "progress" ), ( "🚀", "great progress" ), ( "😰", "fear" ), ( "😴", "indifference" ), ( "😖", "stuck" ) ]
    in
    div [ class "dg-review-panel dg-review-pulse-panel" ]
        [ panelHeading "◉" "Project pulse" "Capture the current texture of the work."
        , div [ class "dg-emoji-row" ] (List.map (\( emoji, label_ ) -> button [ title label_, attribute "aria-label" label_, onClick (AddDiaryText (emoji ++ " " ++ label_)) ] [ span [] [ text emoji ] ]) emojis)
        , div [ class "dg-inline-form" ]
            [ input [ value model.diaryInput, placeholder "Write a diary entry…", onInput DiaryChanged, onEnter (AddDiaryText model.diaryInput) ] []
            , button [ disabled (String.isEmpty (String.trim model.diaryInput)), onClick (AddDiaryText model.diaryInput) ] [ text "Add" ]
            ]
        ]


viewActions : Model -> List Action -> Html Msg
viewActions model actions =
    let
        members =
            reviewMembers model

        contexts =
            model.snapshot.actions |> List.filterMap .context |> uniqueSorted
    in
    section [ class "dg-review-panel dg-review-actions-panel" ]
        [ div [ class "dg-review-panel-heading dg-review-panel-heading-row" ]
            [ span [ class "dg-review-panel-icon" ] [ text "→" ]
            , div [] [ h3 [] [ text "Open Actions" ], p [] [ text "Confirm that the next visible step is concrete." ] ]
            , span [ class "dg-review-count" ] [ text (String.fromInt (List.length actions)) ]
            ]
        , div [ class "dg-action-rows" ] (List.map (viewActionRow model) actions)
        , div [ class "dg-action-capture" ]
            [ input [ value model.actionTitle, placeholder "Define the next physical Action…", onInput ActionTitleChanged, onEnter AddActionNow ] []
            , input [ class "dg-review-project-input", value model.actionProjectQuery, placeholder "Project", list "dg-review-projects", onInput ActionProjectChanged ] []
            , datalist [ id "dg-review-projects" ] (List.map (\project -> option [ value (projectLabel model project) ] []) members)
            , input [ class "dg-review-context-input", value model.context, placeholder "Context", list "dg-review-contexts", onInput ContextChanged ] []
            , datalist [ id "dg-review-contexts" ] (List.map (\context -> option [ value context ] []) contexts)
            , label [ class "dg-capture-toggle", title "Mark as work, independent of the context" ] [ input [ type_ "checkbox", checked model.work, onCheck WorkChanged ] [], span [] [ text "Work" ] ]
            , button [ class "mod-cta", disabled (not (canAddAction model) || model.saving), onClick AddActionNow ] [ text "Add" ]
            ]
        ]


viewActionRow : Model -> Action -> Html Msg
viewActionRow model action =
    div [ class "dg-action-row" ]
        [ input
            [ class "dg-action-row-checkbox"
            , type_ "checkbox"
            , checked (action.status == "done")
            , onCheck
                (\done ->
                    HostCommand Ignore
                        (actionStatusCommand action.id
                            (if done then
                                "done"

                             else
                                "next"
                            )
                        )
                )
            ]
            []
        , div [ class "dg-action-row-main" ]
            [ button [ class "dg-action-row-title", onClick (HostCommand Ignore (openFileCommand action.file.path)) ] [ text action.title ]
            , div [ class "dg-action-row-meta" ]
                (maybeList action.projectId (\id_ -> span [ class "dg-action-project-label" ] [ text (findProject id_ model.snapshot.projects |> Maybe.map (projectBreadcrumb model.snapshot.projects) |> Maybe.withDefault "Missing Project") ])
                    ++ maybeList action.context (\context -> span [] [ text ("@" ++ context) ])
                    ++ maybeList action.due (\due -> span [] [ text ("Due " ++ due) ])
                )
            ]
        , div [ class "dg-action-row-actions" ]
            [ button [ class "dg-action-row-edit", onClick (HostCommand Ignore (actionCommand "edit-action" action.id)) ] [ text "Edit" ]
            , button [ class "dg-action-row-delete", onClick (HostCommand Ignore (actionCommand "trash-action" action.id)) ] [ text "Delete" ]
            ]
        ]


viewDiary : Model -> Html Msg
viewDiary model =
    let
        entries =
            Maybe.map .diary model.reviewData |> Maybe.withDefault []
    in
    div [ class "dg-review-panel dg-review-diary-panel" ]
        [ div [ class "dg-review-panel-heading dg-review-panel-heading-row" ]
            [ span [ class "dg-review-panel-icon" ] [ text "≡" ]
            , div [] [ h3 [] [ text "Diary" ], p [] [ text "Recent observations and decisions." ] ]
            , span [ class "dg-review-count" ] [ text (String.fromInt (List.length entries)) ]
            ]
        , div [ class "dg-diary-list" ]
            (if List.isEmpty entries then
                [ span [ class "dg-muted" ] [ text "No entries yet." ] ]

             else
                List.map (\entry -> div [] [ span [] [ text entry.timestamp ], p [] [ text entry.body ] ]) entries
            )
        ]


viewStats : List Action -> Int -> Html Msg
viewStats doneActions supportFiles =
    div [ class "dg-review-panel dg-review-stats" ]
        [ panelHeading "◇" "Project material" "A quick inventory before moving on."
        , div [ class "dg-review-stat-grid" ]
            [ div [] [ strong [] [ text (String.fromInt (List.length doneActions)) ], span [] [ text (plural (List.length doneActions) "completed Action") ] ]
            , div [] [ strong [] [ text (String.fromInt supportFiles) ], span [] [ text (plural supportFiles "support file") ] ]
            ]
        ]


viewFooter : Model -> Project -> List Project -> Html Msg
viewFooter model project blockers =
    div [ class "dg-workflow-footer" ]
        [ div []
            [ strong []
                [ text
                    (if List.isEmpty blockers then
                        "Ready to move on?"

                     else
                        pluralNeeds (List.length blockers)
                    )
                ]
            , if List.isEmpty blockers then
                text ""

              else
                span [] [ text "Add the missing Next Actions above or move the root Project to Someday/Maybe." ]
            ]
        , div [ class "dg-review-footer-actions" ]
            [ button [ class "mod-warning", disabled model.saving, onClick DeleteProject ] [ text "Delete Project" ]
            , button [ disabled model.saving, onClick MoveToSomeday ] [ text "Move to Someday/Maybe" ]
            , button
                [ class "mod-cta"
                , disabled (model.saving || not (List.isEmpty blockers))
                , title
                    (if List.isEmpty blockers then
                        ""

                     else
                        "Every active sub-project needs a Next Action."
                    )
                , onClick CompleteReview
                ]
                [ text "Mark reviewed and continue →" ]
            ]
        ]


panelHeading : String -> String -> String -> Html Msg
panelHeading icon heading description =
    div [ class "dg-review-panel-heading" ] [ span [ class "dg-review-panel-icon" ] [ text icon ], div [] [ h3 [] [ text heading ], p [] [ text description ] ] ]


maybeError : Maybe String -> Html Msg
maybeError error =
    Maybe.map (\message -> div [ class "dg-panel dg-error" ] [ text message ]) error |> Maybe.withDefault (text "")


currentProject : Model -> Maybe Project
currentProject model =
    List.head model.queue |> Maybe.andThen (\id_ -> findProject id_ model.snapshot.projects)


reviewMembers : Model -> List Project
reviewMembers model =
    case currentProject model of
        Nothing ->
            []

        Just root ->
            model.snapshot.projects
                |> List.filter (\project -> project.id == root.id || isDescendantOf root.id model.snapshot.projects project)
                |> List.sortBy (projectBreadcrumb model.snapshot.projects)


reviewActions : Model -> List Action
reviewActions model =
    let
        ids =
            reviewMembers model |> List.map .id |> Set.fromList
    in
    List.filter (\action -> Maybe.map (\id_ -> Set.member id_ ids) action.projectId |> Maybe.withDefault False) model.snapshot.actions


missingNextProjects : Model -> List Project
missingNextProjects model =
    let
        nextIds =
            reviewActions model |> List.filter (\action -> action.status == "next") |> List.filterMap .projectId |> Set.fromList
    in
    reviewMembers model |> List.filter (\project -> project.status == "active" && not (Set.member project.id nextIds))


blockingProjects : Model -> List Project
blockingProjects model =
    case currentProject model of
        Nothing ->
            []

        Just root ->
            let
                members =
                    reviewMembers model

                missing =
                    missingNextProjects model

                activeChildren =
                    List.any (\project -> project.id /= root.id && project.status == "active") members
            in
            if activeChildren then
                List.filter (\project -> project.id /= root.id) missing

            else
                missing


isDescendantOf : String -> List Project -> Project -> Bool
isDescendantOf rootId projects project =
    let
        walk seen maybeId =
            case maybeId of
                Nothing ->
                    False

                Just id_ ->
                    if id_ == rootId then
                        True

                    else if Set.member id_ seen then
                        False

                    else
                        case findProject id_ projects of
                            Just parent ->
                                walk (Set.insert id_ seen) parent.parentProjectId

                            Nothing ->
                                False
    in
    walk Set.empty project.parentProjectId


relativeLabel : Model -> Project -> Project -> String
relativeLabel model root project =
    projectBreadcrumb model.snapshot.projects project
        |> String.split " > "
        |> List.drop 1
        |> String.join " > "
        |> (\result ->
                if String.isEmpty result then
                    project.title

                else
                    result
           )


projectLabel : Model -> Project -> String
projectLabel model project =
    projectBreadcrumb model.snapshot.projects project


projectBreadcrumb : List Project -> Project -> String
projectBreadcrumb projects project =
    let
        walk seen current titles =
            if Set.member current.id seen then
                "…" :: titles

            else
                case current.parentProjectId |> Maybe.andThen (\id_ -> findProject id_ projects) of
                    Just parent ->
                        walk (Set.insert current.id seen) parent (current.title :: titles)

                    Nothing ->
                        current.title :: titles
    in
    walk Set.empty project [] |> String.join " > "


findProject : String -> List Project -> Maybe Project
findProject id_ projects =
    List.filter (\project -> project.id == id_) projects |> List.head


canAddAction : Model -> Bool
canAddAction model =
    not (String.isEmpty (String.trim model.actionTitle)) && not (String.isEmpty model.actionProjectId) && not (String.isEmpty (String.trim model.context))


activeProjectIds : Model -> List String
activeProjectIds model =
    reviewMembers model |> List.filter (\project -> project.status == "active") |> List.map .id


budget : Int -> Int
budget total =
    if total > 0 then
        3600 // total

    else
        0


formatTimer : Int -> String
formatTimer seconds =
    let
        absolute =
            abs seconds

        padded =
            String.fromInt (modBy 60 absolute) |> String.padLeft 2 '0'
    in
    (if seconds < 0 then
        "−"

     else
        ""
    )
        ++ String.fromInt (absolute // 60)
        ++ ":"
        ++ padded


statusLabel : String -> String
statusLabel status =
    case status of
        "someday" ->
            "Someday/Maybe"

        "active" ->
            "Active"

        "backlog" ->
            "Backlog"

        "completed" ->
            "Completed"

        "cancelled" ->
            "Cancelled"

        _ ->
            status


plural : Int -> String -> String
plural count noun =
    String.fromInt count
        ++ " "
        ++ noun
        ++ (if count == 1 then
                ""

            else
                "s"
           )


pluralNeeds : Int -> String
pluralNeeds count =
    String.fromInt count
        ++ " active Project"
        ++ (if count == 1 then
                " needs"

            else
                "s need"
           )
        ++ " a Next Action."


uniqueSorted : List String -> List String
uniqueSorted values =
    values |> Set.fromList |> Set.toList |> List.sort


maybeList : Maybe a -> (a -> b) -> List b
maybeList maybeValue render =
    Maybe.map (render >> List.singleton) maybeValue |> Maybe.withDefault []


onEnter : Msg -> Html.Attribute Msg
onEnter message =
    on "keydown"
        (Decode.map
            (\key ->
                if key == "Enter" then
                    message

                else
                    NoOp
            )
            (Decode.field "key" Decode.string)
        )


projectCommand : String -> String -> Encode.Value
projectCommand kind projectId =
    Encode.object [ ( "type", Encode.string kind ), ( "projectId", Encode.string projectId ) ]


createProjectCommand : String -> Encode.Value
createProjectCommand parentProjectId =
    Encode.object [ ( "type", Encode.string "create-project" ), ( "parentProjectId", Encode.string parentProjectId ) ]


openFileCommand : String -> Encode.Value
openFileCommand path =
    Encode.object [ ( "type", Encode.string "open-file" ), ( "path", Encode.string path ) ]


actionCommand : String -> String -> Encode.Value
actionCommand kind actionId =
    Encode.object [ ( "type", Encode.string kind ), ( "actionId", Encode.string actionId ) ]


actionStatusCommand : String -> String -> Encode.Value
actionStatusCommand actionId status =
    Encode.object [ ( "type", Encode.string "set-action-status" ), ( "actionId", Encode.string actionId ), ( "status", Encode.string status ) ]


bodyCommand : String -> String -> String -> Encode.Value
bodyCommand kind projectId body =
    Encode.object [ ( "type", Encode.string kind ), ( "projectId", Encode.string projectId ), ( "body", Encode.string body ) ]


createActionCommand : Model -> Encode.Value
createActionCommand model =
    Encode.object
        [ ( "type", Encode.string "create-review-action" )
        , ( "title", Encode.string (String.trim model.actionTitle) )
        , ( "projectId", Encode.string model.actionProjectId )
        , ( "context", Encode.string (String.trim model.context) )
        , ( "work", Encode.bool model.work )
        ]


reviewCommand : String -> String -> Model -> Encode.Value
reviewCommand kind projectId model =
    Encode.object
        [ ( "type", Encode.string kind )
        , ( "projectId", Encode.string projectId )
        , ( "desiredOutcome", Encode.string model.desiredOutcome )
        , ( "activeProjectIds", Encode.list Encode.string (activeProjectIds model) )
        ]


type alias Flags =
    { snapshot : Snapshot, queue : List String, supportCounts : List SupportCount }


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map3 Flags (Decode.field "snapshot" snapshotDecoder) (Decode.field "queue" (Decode.list Decode.string)) (Decode.field "supportCounts" (Decode.list supportCountDecoder))


snapshotDecoder : Decoder Snapshot
snapshotDecoder =
    Decode.map4 Snapshot (Decode.field "revision" Decode.int) (Decode.field "today" Decode.string) (Decode.field "actions" (Decode.list actionDecoder)) (Decode.field "projects" (Decode.list projectDecoder))


fileDecoder : Decoder File
fileDecoder =
    Decode.map File (Decode.field "path" Decode.string)


actionDecoder : Decoder Action
actionDecoder =
    Decode.map7 Action
        (Decode.field "id" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "file" fileDecoder)
        (Decode.field "status" Decode.string)
        (optionalField "projectId" (Decode.maybe Decode.string) Nothing)
        (optionalField "context" (Decode.maybe Decode.string) Nothing)
        (optionalField "due" (Decode.maybe Decode.string) Nothing)


projectDecoder : Decoder Project
projectDecoder =
    Decode.map7 Project
        (Decode.field "id" Decode.string)
        (Decode.field "title" Decode.string)
        (Decode.field "file" fileDecoder)
        (Decode.field "status" Decode.string)
        (optionalField "area" (Decode.maybe Decode.string) Nothing)
        (optionalField "reviewed" (Decode.maybe Decode.string) Nothing)
        (optionalField "parentProjectId" (Decode.maybe Decode.string) Nothing)


diaryDecoder : Decoder DiaryEntry
diaryDecoder =
    Decode.map2 DiaryEntry (optionalField "timestamp" Decode.string "") (Decode.field "text" Decode.string)


reviewDataDecoder : Decoder ReviewData
reviewDataDecoder =
    Decode.map3 ReviewData (Decode.field "projectId" Decode.string) (Decode.field "desiredOutcome" Decode.string) (Decode.field "diary" (Decode.list diaryDecoder))


supportCountDecoder : Decoder SupportCount
supportCountDecoder =
    Decode.map2 SupportCount (Decode.field "projectId" Decode.string) (Decode.field "count" Decode.int)


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" snapshotDecoder)

                    "review-project-data" ->
                        Decode.map ReviewDataEvent (Decode.field "data" reviewDataDecoder)

                    "command-result" ->
                        Decode.map4 CommandResult (Decode.field "requestId" Decode.string) (Decode.field "ok" Decode.bool) (optionalField "error" (Decode.maybe Decode.string) Nothing) (optionalField "value" Decode.value Encode.null)

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


optionalField : String -> Decoder a -> a -> Decoder a
optionalField name decoder fallback =
    Decode.oneOf [ Decode.field name decoder, Decode.succeed fallback ]


emptyProject : Project
emptyProject =
    { id = "", title = "", file = { path = "" }, status = "", area = Nothing, reviewed = Nothing, parentProjectId = Nothing }


emptyModel : String -> Model
emptyModel message =
    { snapshot = { revision = 0, today = "", actions = [], projects = [] }
    , queue = []
    , total = 0
    , supportCounts = Dict.empty
    , reviewData = Nothing
    , desiredOutcome = ""
    , diaryInput = ""
    , actionTitle = ""
    , actionProjectId = ""
    , actionProjectQuery = ""
    , context = ""
    , work = False
    , sessionSeconds = 0
    , projectSeconds = 0
    , nextRequest = 1
    , pending = Dict.empty
    , saving = False
    , error = Just message
    }
