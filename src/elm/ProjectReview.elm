port module ProjectReview exposing (main)

import Browser
import Dict exposing (Dict)
import Gtd.ActionStatus as ActionStatus
import Gtd.Command.ProjectReview as Command exposing (Command)
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ProjectId)
import Gtd.Picker as Picker exposing (Picker)
import Gtd.ProjectStatus as ProjectStatus
import Gtd.Ui as Ui
import Html exposing (Html, button, div, h2, h3, header, input, label, p, section, span, strong, text, textarea)
import Html.Attributes exposing (checked, class, classList, disabled, placeholder, style, title, type_, value)
import Html.Events exposing (onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set exposing (Set)
import Time


port reviewToHost : Encode.Value -> Cmd msg


port reviewFromHost : (Decode.Value -> msg) -> Sub msg


{-| One hour of attention, split evenly across the trees waiting for review.
-}
sessionBudgetSeconds : Int
sessionBudgetSeconds =
    3600


type alias DiaryEntry =
    { timestamp : String, body : String }


type alias ReviewData =
    { projectId : ProjectId, desiredOutcome : String, diary : List DiaryEntry }


{-| What a host reply should finish.
-}
type Pending
    = IgnoreReply
    | Advance ProjectId
    | DeleteAndAdvance ProjectId
    | AppendDiary
    | ClearCapture


{-| Which Projects need an Action, and which block each review root. The host
decides both, so this view never re-implements what counts as a moving Action.
-}
type alias Health =
    { needsAction : Set ProjectId
    , blockers : Dict ProjectId (List ProjectId)
    }


type alias Model =
    { snapshot : Snapshot
    , queue : List ProjectId
    , total : Int
    , health : Health
    , supportCounts : Dict ProjectId Int
    , reviewData : Maybe ReviewData
    , desiredOutcome : String
    , diaryInput : String
    , actionTitle : String
    , project : Picker Project
    , context : Picker String
    , sessionSeconds : Int
    , projectSeconds : Int
    , requests : Requests Pending
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
    | ProjectPicker (Picker.PickerMsg Project)
    | ContextPicker (Picker.PickerMsg String)
    | AddActionNow
    | CompleteReview
    | MoveToSomeday
    | DeleteProject
    | Send Pending Command
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> Sub.batch [ reviewFromHost GotHost, Time.every 1000 Tick ]
        , view = view
        }


type alias SupportCount =
    { projectId : ProjectId, count : Int }


type alias Flags =
    { snapshot : Snapshot, queue : List ProjectId, health : Health, supportCounts : List SupportCount }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue flagsDecoder flags of
        Ok decoded ->
            loadCurrent
                { snapshot = decoded.snapshot
                , queue = decoded.queue
                , total = List.length decoded.queue
                , health = decoded.health
                , supportCounts = countsDict decoded.supportCounts
                , reviewData = Nothing
                , desiredOutcome = ""
                , diaryInput = ""
                , actionTitle = ""
                , project = Picker.init "" Nothing
                , context = Picker.init "" Nothing
                , sessionSeconds = 0
                , projectSeconds = budget (List.length decoded.queue)
                , requests = Host.noRequests
                , saving = False
                , error = Nothing
                }

        Err error ->
            ( emptyModel (Decode.errorToString error), Cmd.none )


countsDict : List SupportCount -> Dict ProjectId Int
countsDict counts =
    Dict.fromList (List.map (\item -> ( item.projectId, item.count )) counts)


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        Tick _ ->
            ( { model | sessionSeconds = model.sessionSeconds + 1, projectSeconds = model.projectSeconds - 1 }, Cmd.none )

        OutcomeChanged outcome ->
            ( { model | desiredOutcome = outcome }, Cmd.none )

        DiaryChanged entry ->
            ( { model | diaryInput = entry }, Cmd.none )

        AddDiaryText entry ->
            case ( currentProject model, String.isEmpty (String.trim entry) ) of
                ( Just project, False ) ->
                    send AppendDiary (Command.AddDiaryEntry project.id entry) model

                _ ->
                    ( model, Cmd.none )

        ActionTitleChanged actionTitle ->
            ( { model | actionTitle = actionTitle }, Cmd.none )

        ProjectPicker pickerMsg ->
            ( { model | project = Picker.update pickerMsg (projectSuggestions model) (projectLabel model) model.project }, Cmd.none )

        ContextPicker pickerMsg ->
            ( { model | context = Picker.update pickerMsg (contextSuggestions model) identity model.context }, Cmd.none )

        AddActionNow ->
            case capture model of
                Just fields ->
                    send ClearCapture (Command.CreateReviewAction fields) { model | saving = True }

                Nothing ->
                    ( model, Cmd.none )

        CompleteReview ->
            case currentProject model of
                Just project ->
                    if List.isEmpty (blockingProjects model) then
                        send (Advance project.id)
                            (Command.CompleteProjectReview project.id model.desiredOutcome (activeProjectIds model))
                            { model | saving = True }

                    else
                        ( { model | error = Just "Add a Next Action or move this Project to Someday/Maybe before continuing." }, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        MoveToSomeday ->
            case currentProject model of
                Just project ->
                    send (Advance project.id)
                        (Command.MoveReviewToSomeday project.id model.desiredOutcome (activeProjectIds model))
                        { model | saving = True }

                Nothing ->
                    ( model, Cmd.none )

        DeleteProject ->
            case currentProject model of
                Just project ->
                    send (DeleteAndAdvance project.id) (Command.TrashProject project.id) { model | saving = True }

                Nothing ->
                    ( model, Cmd.none )

        Send pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests, saving = hasSavingRequest requests }
    , reviewToHost (Host.envelope requestId (Command.encode command))
    )


hasSavingRequest : Requests Pending -> Bool
hasSavingRequest requests =
    Host.pending requests
        |> List.any
            (\pending ->
                case pending of
                    Advance _ ->
                        True

                    DeleteAndAdvance _ ->
                        True

                    ClearCapture ->
                        True

                    AppendDiary ->
                        False

                    IgnoreReply ->
                        False
            )


advance : ProjectId -> Model -> ( Model, Cmd Msg )
advance projectId model =
    loadCurrent
        { model
            | queue = List.filter ((/=) projectId) model.queue
            , projectSeconds = budget model.total
        }


loadCurrent : Model -> ( Model, Cmd Msg )
loadCurrent model =
    case currentProject model of
        Just project ->
            send IgnoreReply (Command.LoadReviewProject project.id) (resetProjectForm model)

        Nothing ->
            ( resetProjectForm model, Cmd.none )


{-| A fresh capture form, aimed at the first Project in the tree that still needs
a Next Action so the obvious next keystroke is the right one.
-}
resetProjectForm : Model -> Model
resetProjectForm model =
    let
        target =
            case blockingProjects model of
                first :: _ ->
                    Just first

                [] ->
                    case missingNextProjects model of
                        first :: _ ->
                            Just first

                        [] ->
                            currentProject model
    in
    { model
        | reviewData = Nothing
        , desiredOutcome = ""
        , diaryInput = ""
        , actionTitle = ""
        , project =
            case target of
                Just project ->
                    Picker.init (projectLabel model project) (Just project)

                Nothing ->
                    Picker.init "" Nothing
        , context = Picker.init "" Nothing
        , error = Nothing
    }



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | ReviewDataEvent ReviewData
    | SupportCountsEvent (List SupportCount)
    | HealthEvent Health
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Err _ ->
            ( model, Cmd.none )

        Ok (SnapshotEvent snapshot) ->
            let
                ids =
                    Set.fromList (List.map .id snapshot.projects)
            in
            ( { model | snapshot = snapshot, queue = List.filter (\id -> Set.member id ids) model.queue }, Cmd.none )

        Ok (SupportCountsEvent counts) ->
            ( { model | supportCounts = countsDict counts }, Cmd.none )

        Ok (HealthEvent health) ->
            ( { model | health = health }, Cmd.none )

        Ok (ReviewDataEvent data) ->
            if List.head model.queue == Just data.projectId then
                ( { model | reviewData = Just data, desiredOutcome = data.desiredOutcome }, Cmd.none )

            else
                ( model, Cmd.none )

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests

                next =
                    { model | requests = requests, saving = hasSavingRequest requests }
            in
            case outcome.result of
                Err message ->
                    ( { next | error = Just message }, Cmd.none )

                Ok resultValue ->
                    finish (Maybe.withDefault IgnoreReply pending)
                        resultValue
                        { next | error = Nothing }


finish : Pending -> Decode.Value -> Model -> ( Model, Cmd Msg )
finish pending resultValue model =
    case pending of
        Advance projectId ->
            advance projectId model

        DeleteAndAdvance projectId ->
            case Decode.decodeValue Decode.bool resultValue of
                Ok True ->
                    advance projectId model

                _ ->
                    ( model, Cmd.none )

        AppendDiary ->
            case Decode.decodeValue diaryDecoder resultValue of
                Ok entry ->
                    ( { model
                        | reviewData = Maybe.map (\data -> { data | diary = entry :: data.diary }) model.reviewData
                        , diaryInput = ""
                      }
                    , Cmd.none
                    )

                Err _ ->
                    ( model, Cmd.none )

        ClearCapture ->
            ( { model | actionTitle = "", context = Picker.init "" Nothing }, Cmd.none )

        IgnoreReply ->
            ( model, Cmd.none )



-- VIEW


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
            List.filter (\action -> ActionStatus.isOpen action.status) actions

        nextActions =
            List.filter (\action -> action.status == ActionStatus.Next) openActions

        doneActions =
            List.filter (\action -> action.status == ActionStatus.Done) actions

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
                [ div [] [ span [] [ text "Session" ], strong [] [ text (Ui.timer model.sessionSeconds) ] ]
                , div [ classList [ ( "is-overdue", model.projectSeconds <= 30 ) ] ] [ span [] [ text "Project budget" ], strong [] [ text (Ui.timer model.projectSeconds) ] ]
                ]
            ]
        , div [ class "dg-progress-track" ] [ span [ style "width" (String.fromFloat progress ++ "%") ] [] ]
        , Ui.maybeView model.error (\message -> div [ class "dg-panel dg-error" ] [ text message ])
        , div [ class "dg-review-content" ]
            [ section [ class "dg-review-hero" ]
                [ div [ class "dg-review-hero-copy" ]
                    [ span [ class "dg-review-eyebrow" ]
                        [ text ("Project tree " ++ String.fromInt (model.total - List.length model.queue + 1) ++ " of " ++ String.fromInt model.total) ]
                    , button [ class "dg-project-title dg-flat-button", onClick (Send IgnoreReply (Command.OpenFile project.file.path)) ] [ text project.title ]
                    , div [ class "dg-review-project-meta" ]
                        [ span [ class "dg-status" ] [ text (Maybe.withDefault (ProjectStatus.label project.status) project.area) ]
                        , span [] [ text (Ui.plural (List.length members) "Project") ]
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
            , section [ class "dg-review-grid" ] [ viewOutcome model, viewPulse model ]
            , viewActions model openActions
            , section [ class "dg-review-grid" ] [ viewDiary model, viewStats doneActions supportFiles ]
            , viewFooter model blockers
            ]
        ]


viewTree : Model -> Project -> List Project -> List Action -> Html Msg
viewTree model root subprojects actions =
    section [ class "dg-review-panel dg-review-tree-panel" ]
        [ div [ class "dg-review-panel-heading dg-review-panel-heading-row" ]
            [ span [ class "dg-review-panel-icon" ] [ text "⌘" ]
            , div [] [ h3 [] [ text "Project tree" ], p [] [ text "Reviewed together as one outcome hierarchy." ] ]
            , span [ class "dg-review-count" ] [ text (String.fromInt (List.length subprojects)) ]
            , button [ class "dg-review-tree-add", onClick (Send IgnoreReply (Command.NewProjectModal (Just root.id))) ] [ text "New sub-project" ]
            ]
        , if List.isEmpty subprojects then
            div [ class "dg-review-tree-empty" ] [ text "No sub-projects yet." ]

          else
            div [ class "dg-review-tree-list" ] (List.map (viewTreeRow model root actions) subprojects)
        ]


viewTreeRow : Model -> Project -> List Action -> Project -> Html Msg
viewTreeRow model root actions project =
    let
        projectActions =
            List.filter (\action -> action.projectId == Just project.id && ActionStatus.isOpen action.status) actions

        nextCount =
            List.filter (\action -> action.status == ActionStatus.Next) projectActions |> List.length
    in
    div []
        [ button
            [ class "dg-flat-button"

            , onClick (Send IgnoreReply (Command.OpenFile project.file.path))
            ]
            [ text (relativeLabel model root project) ]
        , span [] [ text (ProjectStatus.label project.status) ]
        , span [] [ text (String.fromInt (List.length projectActions) ++ " open · " ++ String.fromInt nextCount ++ " next") ]
        , if needsAction model project then
            strong [] [ text "No Next Action" ]

          else if project.status == ProjectStatus.Backlog then
            -- The review is where planned work gets pulled in.
            button
                [ class "dg-review-activate dg-flat-button"

                , onClick (Send IgnoreReply (Command.SetProjectStatus project.id ProjectStatus.Active))
                ]
                [ text "Activate" ]

          else
            text ""
        ]


viewOutcome : Model -> Html Msg
viewOutcome model =
    div [ class "dg-review-panel dg-review-outcome-panel" ]
        [ panelHeading "◎" "Desired outcome" "Reconnect with what done looks like."
        , textarea [ value model.desiredOutcome, placeholder "What will be true when this Project is complete?", onInput OutcomeChanged ] []
        ]


viewPulse : Model -> Html Msg
viewPulse model =
    let
        emojis =
            [ ( "👍", "no progress, but looks good" )
            , ( "🌱", "slow progress" )
            , ( "🛠️", "progress" )
            , ( "🚀", "great progress" )
            , ( "😰", "fear" )
            , ( "😴", "indifference" )
            , ( "😖", "stuck" )
            ]
    in
    div [ class "dg-review-panel dg-review-pulse-panel" ]
        [ panelHeading "◉" "Project pulse" "Capture the current texture of the work."
        , div [ class "dg-emoji-row" ]
            (List.map
                (\( emoji, description ) ->
                    button
                        [ onClick (AddDiaryText (emoji ++ " " ++ description)) ]
                        (Ui.iconLabel emoji description)
                )
                emojis
            )
        , div [ class "dg-inline-form" ]
            [ input
                [ value model.diaryInput
                , placeholder "Write a diary entry…"
                , onInput DiaryChanged
                , Ui.onEnter { enter = AddDiaryText model.diaryInput, ignore = NoOp }
                ]
                []
            , button [ disabled (String.isEmpty (String.trim model.diaryInput)), onClick (AddDiaryText model.diaryInput) ] [ text "Add" ]
            ]
        ]


viewActions : Model -> List Action -> Html Msg
viewActions model actions =
    section [ class "dg-review-panel dg-review-actions-panel" ]
        [ div [ class "dg-review-panel-heading dg-review-panel-heading-row" ]
            [ span [ class "dg-review-panel-icon" ] [ text "→" ]
            , div [] [ h3 [] [ text "Open Actions" ], p [] [ text "Confirm that the next visible step is concrete." ] ]
            , span [ class "dg-review-count" ] [ text (String.fromInt (List.length actions)) ]
            ]
        , div [ class "dg-action-rows" ] (List.map (viewActionRow model) actions)
        , div [ class "dg-action-capture" ]
            [ input
                [ value model.actionTitle
                , placeholder "Define the next physical Action…"
                , onInput ActionTitleChanged
                , Ui.onEnter { enter = AddActionNow, ignore = NoOp }
                ]
                []
            , Picker.view (projectPicker model) (projectSuggestions model) model.project
            , Picker.view (contextPicker model) (contextSuggestions model) model.context
            , button [ class "mod-cta", disabled (capture model == Nothing || model.saving), onClick AddActionNow ] [ text "Add" ]
            ]
        ]


viewActionRow : Model -> Action -> Html Msg
viewActionRow model action =
    div [ class "dg-action-row" ]
        [ input
            [ class "dg-action-row-checkbox"
            , type_ "checkbox"
            , checked (action.status == ActionStatus.Done)
            , onCheck (\done -> Send IgnoreReply (Command.SetActionStatus action.id (completionStatus done)))
            ]
            []
        , div [ class "dg-action-row-main" ]
            [ button [ class "dg-action-row-title dg-flat-button", onClick (Send IgnoreReply (Command.OpenFile action.file.path)) ] [ text action.title ]
            , div [ class "dg-action-row-meta" ]
                (Ui.maybeList action.projectId
                    (\projectId ->
                        span [ class "dg-action-project-label" ]
                            [ text (Hierarchy.breadcrumbFor model.snapshot.projects projectId |> Maybe.withDefault "Missing Project") ]
                    )
                    ++ Ui.maybeList action.context (\context -> span [] [ text ("@" ++ context) ])
                    ++ Ui.maybeList action.due (\due -> span [] [ text ("Due " ++ due) ])
                )
            ]
        , div [ class "dg-action-row-actions" ]
            [ button [ class "dg-action-row-edit dg-flat-button", onClick (Send IgnoreReply (Command.EditActionModal action.id)) ] [ text "Edit" ]
            , button [ class "dg-action-row-delete dg-flat-button", onClick (Send IgnoreReply (Command.TrashAction action.id)) ] [ text "Delete" ]
            ]
        ]


completionStatus : Bool -> ActionStatus.ActionStatus
completionStatus done =
    if done then
        ActionStatus.Done

    else
        ActionStatus.Next


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
            [ div [] [ strong [] [ text (String.fromInt (List.length doneActions)) ], span [] [ text (Ui.plural (List.length doneActions) "completed Action") ] ]
            , div [] [ strong [] [ text (String.fromInt supportFiles) ], span [] [ text (Ui.plural supportFiles "support file") ] ]
            ]
        ]


viewFooter : Model -> List Project -> Html Msg
viewFooter model blockers =
    div [ class "dg-workflow-footer" ]
        [ div []
            [ strong []
                [ text
                    (if List.isEmpty blockers then
                        "Ready to move on?"

                     else
                        missingNextSentence (List.length blockers)
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
    div [ class "dg-review-panel-heading" ]
        [ span [ class "dg-review-panel-icon" ] [ text icon ]
        , div [] [ h3 [] [ text heading ], p [] [ text description ] ]
        ]


missingNextSentence : Int -> String
missingNextSentence count =
    String.fromInt count
        ++ " active Project"
        ++ (if count == 1 then
                " needs"

            else
                "s need"
           )
        ++ " a Next Action."



-- PICKERS


projectPicker : Model -> Picker.Config Project Msg
projectPicker model =
    Picker.config
        { placeholder = "Project"
        , label = projectLabel model
        , hint = always Nothing
        , tag = ProjectPicker
        }


contextPicker : Model -> Picker.Config String Msg
contextPicker _ =
    Picker.config
        { placeholder = "Context"
        , label = identity
        , hint = always Nothing
        , tag = ContextPicker
        }


{-| Only the Projects in the tree under review can receive a captured Action.
-}
projectSuggestions : Model -> List Project
projectSuggestions model =
    reviewMembers model
        |> List.filter (\project -> Ui.matches model.project.query [ projectLabel model project ])
        |> List.take 8


contextSuggestions : Model -> List String
contextSuggestions model =
    Data.contexts model.snapshot.actions
        |> List.filter (\candidate -> Ui.matches model.context.query [ candidate ])
        |> List.take 8


projectLabel : Model -> Project -> String
projectLabel model project =
    Hierarchy.breadcrumb model.snapshot.projects project



-- QUERIES


{-| The Action the capture row would create, once it names all three required parts.
-}
capture : Model -> Maybe { title : String, projectId : ProjectId, context : String }
capture model =
    case ( String.trim model.actionTitle, Picker.selection model.project, Picker.query model.context ) of
        ( "", _, _ ) ->
            Nothing

        ( _, Nothing, _ ) ->
            Nothing

        ( _, _, "" ) ->
            Nothing

        ( actionTitle, Just project, context ) ->
            Just { title = actionTitle, projectId = project.id, context = context }


currentProject : Model -> Maybe Project
currentProject model =
    List.head model.queue |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects)


reviewMembers : Model -> List Project
reviewMembers model =
    case currentProject model of
        Nothing ->
            []

        Just root ->
            model.snapshot.projects
                |> List.filter (\project -> project.id == root.id || Hierarchy.isDescendantOf root.id model.snapshot.projects project)
                |> List.sortBy (Hierarchy.breadcrumb model.snapshot.projects)


reviewActions : Model -> List Action
reviewActions model =
    let
        ids =
            reviewMembers model |> List.map .id |> Set.fromList
    in
    List.filter (\action -> Maybe.map (\id -> Set.member id ids) action.projectId |> Maybe.withDefault False) model.snapshot.actions


missingNextProjects : Model -> List Project
missingNextProjects model =
    reviewMembers model |> List.filter (needsAction model)


needsAction : Model -> Project -> Bool
needsAction model project =
    Set.member project.id model.health.needsAction


{-| The active Projects that still have to name a Next Action before the tree can
be marked reviewed, as the host's review gate decided.
-}
blockingProjects : Model -> List Project
blockingProjects model =
    case currentProject model of
        Nothing ->
            []

        Just root ->
            Dict.get root.id model.health.blockers
                |> Maybe.withDefault []
                |> List.filterMap (\projectId -> Data.findProject projectId model.snapshot.projects)


relativeLabel : Model -> Project -> Project -> String
relativeLabel model root project =
    let
        relative =
            Hierarchy.breadcrumb model.snapshot.projects project
                |> String.split Hierarchy.separator
                |> List.drop 1
                |> String.join Hierarchy.separator
    in
    if String.isEmpty relative then
        project.title

    else
        relative


activeProjectIds : Model -> List ProjectId
activeProjectIds model =
    reviewMembers model |> List.filter (\project -> project.status == ProjectStatus.Active) |> List.map .id


budget : Int -> Int
budget total =
    if total > 0 then
        sessionBudgetSeconds // total

    else
        0



-- DECODING


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map4 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "queue" (Decode.list Decode.string))
        (Decode.field "health" healthDecoder)
        (Decode.field "supportCounts" (Decode.list supportCountDecoder))


healthDecoder : Decoder Health
healthDecoder =
    Decode.map2 Health
        (Decode.field "needsAction" (Decode.list Decode.string) |> Decode.map Set.fromList)
        (Decode.field "blockers"
            (Decode.list
                (Decode.map2 Tuple.pair
                    (Decode.field "projectId" Decode.string)
                    (Decode.field "blockerIds" (Decode.list Decode.string))
                )
            )
            |> Decode.map Dict.fromList
        )


supportCountDecoder : Decoder SupportCount
supportCountDecoder =
    Decode.map2 SupportCount (Decode.field "projectId" Decode.string) (Decode.field "count" Decode.int)


diaryDecoder : Decoder DiaryEntry
diaryDecoder =
    Decode.map2 DiaryEntry
        (Decode.oneOf [ Decode.field "timestamp" Decode.string, Decode.succeed "" ])
        (Decode.field "text" Decode.string)


reviewDataDecoder : Decoder ReviewData
reviewDataDecoder =
    Decode.map3 ReviewData
        (Decode.field "projectId" Decode.string)
        (Decode.field "desiredOutcome" Decode.string)
        (Decode.field "diary" (Decode.list diaryDecoder))


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "review-project-data" ->
                        Decode.map ReviewDataEvent (Decode.field "data" reviewDataDecoder)

                    "support-counts" ->
                        Decode.map SupportCountsEvent (Decode.field "counts" (Decode.list supportCountDecoder))

                    "review-health" ->
                        Decode.map HealthEvent (Decode.field "health" healthDecoder)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )


emptyModel : String -> Model
emptyModel message =
    { snapshot = Data.empty
    , queue = []
    , total = 0
    , health = { needsAction = Set.empty, blockers = Dict.empty }
    , supportCounts = Dict.empty
    , reviewData = Nothing
    , desiredOutcome = ""
    , diaryInput = ""
    , actionTitle = ""
    , project = Picker.init "" Nothing
    , context = Picker.init "" Nothing
    , sessionSeconds = 0
    , projectSeconds = 0
    , requests = Host.noRequests
    , saving = False
    , error = Just message
    }
